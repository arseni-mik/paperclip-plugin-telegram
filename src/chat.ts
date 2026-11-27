// Plain-message chat between an allowlisted Telegram user and a Paperclip agent.
//
// Each (chat, agent) pair has one task. A Telegram message is posted on it as a
// comment attributed to a real board user, which wakes the assigned agent the
// same way a comment typed in the web app does (a plugin's own comments never
// wake anyone). The agent's comments on that task are sent back to the chat.
import type { Agent, PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { sendMessage, sendChatAction } from "./telegram-api.js";
import { METRIC_NAMES } from "./constants.js";

export const CHAT_TITLE_PREFIX = "Telegram chat with ";

// Telegram rejects messages over 4096 characters.
const MAX_CHUNK = 4000;

export type ChatConfig = {
  enableChat?: boolean;
  chatAgent?: string;
  chatUserId?: string;
  chatMentionAgents?: string[];
  allowedTelegramUserIds?: string[];
};

type ChatTask = { issueId: string };

export type ChatIssueLink = {
  chatId: string;
  companyId: string;
  agentId: string;
  agentName: string;
  isDefaultAgent: boolean;
};

const taskKey = (chatId: string, agentId: string) => `chat_task_${chatId}_${agentId}`;
const linkKey = (issueId: string) => `chat_issue_${issueId}`;
const sentKey = (commentId: string) => `chat_sent_${commentId}`;

// Chat is opt-in and fails closed: an empty user allowlist means "anyone" for
// the rest of the plugin, which must never apply to talking to an agent.
export function isChatEnabled(config: ChatConfig): boolean {
  return config.enableChat === true && (config.allowedTelegramUserIds ?? []).some((id) => String(id).trim() !== "");
}

// True when the issue belongs to one of the listed agents, or no list is set.
/**
 * The new status carried by an `issue.updated` event. Changes made through the
 * API report `status`; changes Paperclip applies itself when an agent run ends
 * (native status decisions) report `toStatus` instead.
 */
export function updatedStatus(payload: Record<string, unknown>): unknown {
  return payload.status ?? payload.toStatus;
}

export async function isNotifiableAgentIssue(
  ctx: PluginContext,
  event: PluginEvent,
  agentRefs: string[] | undefined,
): Promise<boolean> {
  const refs = (agentRefs ?? []).filter((ref) => ref.trim() !== "");
  if (refs.length === 0) return true;
  try {
    const issue = event.entityId ? await ctx.issues.get(event.entityId, event.companyId) : null;
    if (!issue?.assigneeAgentId) return false;
    const agents = await ctx.agents.list({ companyId: event.companyId });
    const assignee = agents.find((a) => a.id === issue.assigneeAgentId);
    return Boolean(assignee && refs.some((ref) => matchesAgent(assignee, ref)));
  } catch (err) {
    // A lookup failure must not silently drop a notification.
    ctx.logger.warn("Could not check the notification agent filter", { error: String(err) });
    return true;
  }
}

function matchesAgent(agent: Agent, ref: string): boolean {
  const wanted = ref.trim().toLowerCase();
  const urlKey = (agent as unknown as { urlKey?: string }).urlKey;
  return agent.id.toLowerCase() === wanted
    || agent.name.toLowerCase() === wanted
    || urlKey?.toLowerCase() === wanted;
}

export function splitMessage(text: string, limit = MAX_CHUNK): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function taskDescription(agentName: string): string {
  return [
    `This task is a Telegram conversation with ${agentName}.`,
    "",
    "Each new comment from the board user is a message sent from Telegram. For every message:",
    "1. Answer with a comment on this task. The comment is delivered to Telegram as is, so write it as a chat reply: short, plain text, no headings.",
    "2. Then mark this task done. The next message reopens it.",
    "",
    "If answering needs longer work or another agent, say so in a comment first.",
  ].join("\n");
}

async function ensureChatTask(
  ctx: PluginContext,
  chatId: string,
  companyId: string,
  agent: Agent,
): Promise<string> {
  const stored = await ctx.state.get({ scopeKind: "instance", stateKey: taskKey(chatId, agent.id) }) as ChatTask | null;
  if (stored?.issueId) {
    const issue = await ctx.issues.get(stored.issueId, companyId);
    if (issue && issue.status !== "cancelled" && issue.assigneeAgentId === agent.id) {
      // Closed tasks are never woken, so reopen before posting the message.
      if (issue.status === "done") await ctx.issues.update(issue.id, { status: "todo" }, companyId);
      return issue.id;
    }
  }

  const created = await ctx.issues.create({
    companyId,
    title: `${CHAT_TITLE_PREFIX}${agent.name}`,
    description: taskDescription(agent.name),
    assigneeAgentId: agent.id,
  });
  // A task left in the backlog is not worked on.
  await ctx.issues.update(created.id, { status: "todo" }, companyId);
  await ctx.state.set(
    { scopeKind: "instance", stateKey: taskKey(chatId, agent.id) },
    { issueId: created.id } satisfies ChatTask,
  );
  return created.id;
}

export async function handleChatMessage(
  ctx: PluginContext,
  token: string,
  config: ChatConfig,
  // `about` names the task a notification reply refers to; such a message always
  // goes to the default agent.
  message: { chatId: string; text: string; about?: string },
  companyId: string,
): Promise<void> {
  const { chatId } = message;
  const reply = (text: string) => sendMessage(ctx, token, chatId, text);

  const userId = config.chatUserId?.trim();
  const defaultRef = config.chatAgent?.trim();
  if (!userId || !defaultRef) {
    await reply("Chat is not fully configured: set the chat agent and the Paperclip user ID in the plugin settings.");
    return;
  }

  try {
    const agents = await ctx.agents.list({ companyId });
    const defaultAgent = agents.find((a) => matchesAgent(a, defaultRef));
    if (!defaultAgent) {
      await reply(`Chat agent "${defaultRef}" was not found.`);
      return;
    }

    let agent = defaultAgent;
    let text = message.text.trim();
    const mention = message.about ? null : text.match(/^@([^\s:,]+)[\s:,]*/);
    if (mention) {
      const named = agents.find((a) => matchesAgent(a, mention[1]!));
      if (named) {
        const allowed = named.id === defaultAgent.id
          || (config.chatMentionAgents ?? []).some((ref) => matchesAgent(named, ref));
        if (!allowed) {
          await reply(`Chatting with ${named.name} is not enabled.`);
          return;
        }
        agent = named;
        text = text.slice(mention[0].length).trim();
      }
    }
    if (!text) {
      await reply("There is no message to send.");
      return;
    }

    const issueId = await ensureChatTask(ctx, chatId, companyId, agent);
    // Stored before the comment so a fast answer is already routable.
    await ctx.state.set(
      { scopeKind: "instance", stateKey: linkKey(issueId) },
      {
        chatId,
        companyId,
        agentId: agent.id,
        agentName: agent.name,
        isDefaultAgent: agent.id === defaultAgent.id,
      } satisfies ChatIssueLink,
    );
    const body = message.about ? `Re ${message.about}: ${text}` : text;
    await ctx.issues.createComment(issueId, body, companyId, { actorUserId: userId });
    await sendChatAction(ctx, token, chatId);
    await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
    ctx.logger.info("Routed Telegram message to agent chat", { issueId, agentId: agent.id });
  } catch (err) {
    // Never throw: an error escaping the update handler wedges the poller.
    ctx.logger.error("Failed to route chat message", { error: String(err) });
    await reply("Your message could not be delivered to the agent. Check the plugin log.");
  }
}

export async function getChatIssueLink(ctx: PluginContext, issueId: string): Promise<ChatIssueLink | null> {
  return await ctx.state.get({ scopeKind: "instance", stateKey: linkKey(issueId) }) as ChatIssueLink | null;
}

// Chat tasks are opened, closed and reopened constantly, so they are excluded
// from issue notifications. The title check covers the creation event, which
// can arrive before the link is stored.
export async function isChatIssueEvent(ctx: PluginContext, event: PluginEvent): Promise<boolean> {
  const title = (event.payload as Record<string, unknown> | undefined)?.title;
  if (typeof title === "string" && title.startsWith(CHAT_TITLE_PREFIX)) return true;
  return event.entityId ? (await getChatIssueLink(ctx, event.entityId)) !== null : false;
}

export async function forwardChatReply(ctx: PluginContext, token: string, event: PluginEvent): Promise<boolean> {
  if (!event.entityId) return false;
  const link = await getChatIssueLink(ctx, event.entityId);
  if (!link || link.companyId !== event.companyId) return false;

  const commentId = (event.payload as Record<string, unknown> | undefined)?.commentId;
  if (typeof commentId !== "string") return false;
  if (await ctx.state.get({ scopeKind: "instance", stateKey: sentKey(commentId) })) return false;

  // The event carries only a short snippet, so read the full comment.
  const comments = await ctx.issues.listComments(event.entityId, event.companyId);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment || comment.deletedAt) return false;
  const authorAgentId = comment.authorAgentId ?? comment.derivedAuthorAgentId ?? null;
  // Only agent answers go back: never the user's own messages or system notices.
  // A comment an agent wrote through a board session has a derived agent author.
  if (!authorAgentId || comment.authorType === "system") return false;

  await ctx.state.set({ scopeKind: "instance", stateKey: sentKey(commentId) }, true);
  const prefix = link.isDefaultAgent && authorAgentId === link.agentId ? "" : `${link.agentName}: `;
  for (const chunk of splitMessage(`${prefix}${comment.body}`)) {
    await sendMessage(ctx, token, link.chatId, chunk);
  }
  return true;
}
