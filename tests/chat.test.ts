import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const sent: Array<{ chatId: string; text: string }> = [];

vi.mock("@paperclipai/plugin-sdk", async () => {
  const actual = await vi.importActual("@paperclipai/plugin-sdk") as Record<string, unknown>;
  return { ...actual, runWorker: vi.fn() };
});

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string) => {
      sent.push({ chatId, text });
      return 1;
    }),
    sendChatAction: vi.fn(),
    answerCallbackQuery: vi.fn(),
  };
});

import { handleUpdate } from "../src/worker.js";
import { forwardChatReply, isChatEnabled, isChatIssueEvent, isNotifiableAgentIssue, splitMessage, updatedStatus, closingComment } from "../src/chat.js";
import { formatIssueDone } from "../src/formatters.js";

const CHAT = 1000;
const COMPANY = "company-1";
const lead = { id: "agent-lead", name: "Lead", urlKey: "lead" };
const helper = { id: "agent-helper", name: "Helper", urlKey: "helper" };

function mockCtx() {
  const store = new Map<string, unknown>();
  const issues = new Map<string, Record<string, unknown>>();
  const comments: Array<Record<string, unknown>> = [];
  let n = 0;
  const ctx = {
    http: { fetch: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) }) },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: {
      get: vi.fn(async ({ stateKey }: { stateKey: string }) => store.get(stateKey) ?? null),
      set: vi.fn(async ({ stateKey }: { stateKey: string }, value: unknown) => { store.set(stateKey, value); }),
    },
    agents: { list: vi.fn().mockResolvedValue([lead, helper]) },
    companies: { get: vi.fn().mockResolvedValue(null) },
    projects: { list: vi.fn().mockResolvedValue([]) },
    issues: {
      get: vi.fn(async (id: string) => issues.get(id) ?? null),
      create: vi.fn(async (input: Record<string, unknown>) => {
        const issue = { id: `issue-${++n}`, status: "todo", ...input };
        issues.set(issue.id, issue);
        return issue;
      }),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => Object.assign(issues.get(id)!, patch)),
      createComment: vi.fn(async () => ({ id: "c-user" })),
      listComments: vi.fn(async () => comments),
    },
  };
  return { ctx: ctx as unknown as PluginContext, raw: ctx, store, issues, comments };
}

const config = {
  enableChat: true,
  enableInbound: true,
  enableCommands: false,
  chatAgent: "lead",
  chatUserId: "user-1",
  allowedTelegramUserIds: ["42"],
  allowedTelegramChatIds: [String(CHAT)],
} as unknown as Parameters<typeof handleUpdate>[2];

function message(text: string, extra: Record<string, unknown> = {}, fromId = 42): Parameters<typeof handleUpdate>[3] {
  return {
    update_id: 1,
    message: { message_id: 5, chat: { id: CHAT, type: "private" }, from: { id: fromId }, text, ...extra },
  } as Parameters<typeof handleUpdate>[3];
}

const run = (ctx: PluginContext, update: Parameters<typeof handleUpdate>[3], cfg = config) =>
  handleUpdate(ctx, "token", cfg, update, "http://localhost:3100", undefined, undefined, [COMPANY]);

beforeEach(() => { sent.length = 0; });

describe("chat", () => {
  it("is off unless enabled and a user allowlist exists", () => {
    expect(isChatEnabled({ enableChat: true })).toBe(false);
    expect(isChatEnabled({ enableChat: true, allowedTelegramUserIds: [] })).toBe(false);
    expect(isChatEnabled({ allowedTelegramUserIds: ["1"] })).toBe(false);
    expect(isChatEnabled({ enableChat: true, allowedTelegramUserIds: ["1"] })).toBe(true);
  });

  it("posts a plain private message as the user on a task assigned to the agent", async () => {
    const { ctx, raw } = mockCtx();
    await run(ctx, message("how many unread?"));
    expect(raw.issues.create).toHaveBeenCalledWith(expect.objectContaining({ assigneeAgentId: lead.id, companyId: COMPANY }));
    expect(raw.issues.createComment).toHaveBeenCalledWith("issue-1", "how many unread?", COMPANY, { actorUserId: "user-1" });
  });

  it("ignores users who are not allowlisted", async () => {
    const { ctx, raw } = mockCtx();
    await run(ctx, message("hello", {}, 99));
    expect(raw.issues.createComment).not.toHaveBeenCalled();
  });

  it("ignores group chats", async () => {
    const { ctx, raw } = mockCtx();
    await run(ctx, message("hello", { chat: { id: CHAT, type: "supergroup" } }));
    expect(raw.issues.createComment).not.toHaveBeenCalled();
  });

  it("does nothing when chat is disabled", async () => {
    const { ctx, raw } = mockCtx();
    await run(ctx, message("hello"), { ...config, enableChat: false });
    expect(raw.issues.createComment).not.toHaveBeenCalled();
  });

  it("reuses the task and reopens it when done", async () => {
    const { ctx, raw, issues } = mockCtx();
    await run(ctx, message("one"));
    issues.get("issue-1")!.status = "done";
    await run(ctx, message("two"));
    expect(raw.issues.create).toHaveBeenCalledTimes(1);
    expect(raw.issues.update).toHaveBeenCalledWith("issue-1", { status: "todo" }, COMPANY);
    // once when created, once when reopened
    expect(raw.issues.update).toHaveBeenCalledTimes(2);
  });

  it("starts a new task when the old one was cancelled", async () => {
    const { ctx, raw, issues } = mockCtx();
    await run(ctx, message("one"));
    issues.get("issue-1")!.status = "cancelled";
    await run(ctx, message("two"));
    expect(raw.issues.create).toHaveBeenCalledTimes(2);
  });

  it("allows only listed agents to be mentioned", async () => {
    const { ctx, raw } = mockCtx();
    await run(ctx, message("@helper do it"));
    expect(raw.issues.createComment).not.toHaveBeenCalled();
    expect(sent.at(-1)!.text).toContain("not enabled");
    await run(ctx, message("@helper do it"), { ...config, chatMentionAgents: ["Helper"] });
    expect(raw.issues.create).toHaveBeenCalledWith(expect.objectContaining({ assigneeAgentId: helper.id }));
    expect(raw.issues.createComment).toHaveBeenCalledWith("issue-1", "do it", COMPANY, { actorUserId: "user-1" });
  });

  it("does not throw when delivery fails", async () => {
    const { ctx, raw } = mockCtx();
    raw.issues.createComment.mockRejectedValueOnce(new Error("nope"));
    await expect(run(ctx, message("hello"))).resolves.toBeUndefined();
    expect(sent.at(-1)!.text).toContain("could not be delivered");
  });

  it("sends agent comments back once and never the user's own", async () => {
    const { ctx, comments } = mockCtx();
    await run(ctx, message("hello"));
    sent.length = 0;
    comments.push(
      { id: "c-user", authorType: "user", authorAgentId: null, body: "hello" },
      { id: "c-system", authorType: "system", authorAgentId: null, derivedAuthorAgentId: lead.id, body: "notice" },
      { id: "c-agent", authorType: "agent", authorAgentId: lead.id, body: "3 unread" },
    );
    const event = (commentId: string) => ({ entityId: "issue-1", companyId: COMPANY, payload: { commentId } }) as never;
    expect(await forwardChatReply(ctx, "token", event("c-user"))).toBe(false);
    expect(await forwardChatReply(ctx, "token", event("c-system"))).toBe(false);
    expect(await forwardChatReply(ctx, "token", event("c-agent"))).toBe(true);
    expect(await forwardChatReply(ctx, "token", event("c-agent"))).toBe(false);
    expect(sent).toEqual([{ chatId: String(CHAT), text: "3 unread" }]);
  });

  it("marks chat tasks so they raise no issue notifications", async () => {
    const { ctx } = mockCtx();
    expect(await isChatIssueEvent(ctx, { payload: { title: "Telegram chat with Lead" } } as never)).toBe(true);
    await run(ctx, message("hello"));
    expect(await isChatIssueEvent(ctx, { entityId: "issue-1", payload: {} } as never)).toBe(true);
    expect(await isChatIssueEvent(ctx, { entityId: "other", payload: { title: "Fix" } } as never)).toBe(false);
  });

  it("splits long answers under the Telegram limit", () => {
    const chunks = splitMessage("word ".repeat(2000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4000)).toBe(true);
  });
});

describe("optional features are off by default", () => {
  it.each(["acp", "commands"])("/%s answers that it is disabled", async (command) => {
    const { ctx } = mockCtx();
    const text = `/${command} list`;
    await run(ctx, message(text, { entities: [{ type: "bot_command", offset: 0, length: command.length + 1 }] }),
      { ...config, enableCommands: true });
    expect(sent.at(-1)!.text).toContain("disabled");
  });
});

describe("replies to notifications", () => {
  const replyTo = (text: string) => message(text, { reply_to_message: { message_id: 77, from: { is_bot: true } } });

  it("go to the chat agent and name the task", async () => {
    const { ctx, raw, store, issues } = mockCtx();
    issues.set("task-9", { id: "task-9", identifier: "ABC-9", status: "done" });
    store.set(`msg_${CHAT}_77`, { entityId: "task-9", entityType: "issue", companyId: COMPANY });
    await run(ctx, replyTo("@helper apply 1, 2"));
    expect(raw.issues.createComment).toHaveBeenCalledTimes(1);
    expect(raw.issues.createComment).toHaveBeenCalledWith("issue-1", "Re ABC-9: @helper apply 1, 2", COMPANY, { actorUserId: "user-1" });
    expect(raw.issues.create).toHaveBeenCalledWith(expect.objectContaining({ assigneeAgentId: lead.id }));
  });

  it("stay on the task when chat is off", async () => {
    const { ctx, raw, store } = mockCtx();
    store.set(`msg_${CHAT}_77`, { entityId: "task-9", entityType: "issue", companyId: COMPANY });
    await run(ctx, replyTo("noted"), { ...config, enableChat: false });
    expect(raw.issues.createComment).toHaveBeenCalledWith("task-9", "noted", COMPANY);
  });
});

describe("notification filter and length", () => {
  const event = { entityId: "task-9", companyId: COMPANY, payload: {} } as never;

  it("passes everything without a list and only listed agents with one", async () => {
    const { ctx, issues } = mockCtx();
    issues.set("task-9", { id: "task-9", assigneeAgentId: helper.id });
    expect(await isNotifiableAgentIssue(ctx, event, [])).toBe(true);
    expect(await isNotifiableAgentIssue(ctx, event, ["Lead"])).toBe(false);
    expect(await isNotifiableAgentIssue(ctx, event, ["helper"])).toBe(true);
    issues.set("task-9", { id: "task-9" });
    expect(await isNotifiableAgentIssue(ctx, event, ["Lead"])).toBe(false);
  });

  it("cuts the comment at the given length", () => {
    const done = { entityId: "x", payload: { identifier: "ABC-1", title: "T", comment: "word ".repeat(300) } } as never;
    expect(formatIssueDone(done).text.length).toBeLessThan(500);
    expect(formatIssueDone(done, undefined, 1000).text.length).toBeGreaterThan(900);
  });
});

describe("status of an updated task", () => {
  it("reads API changes and Paperclip's own status decisions alike", () => {
    expect(updatedStatus({ status: "done" })).toBe("done");
    // Shape Paperclip publishes when it closes a task at the end of an agent run.
    expect(updatedStatus({ source: "native_status_decision", fromStatus: "in_progress", toStatus: "done" })).toBe("done");
    expect(updatedStatus({ source: "native_status_decision", fromStatus: "todo", toStatus: "blocked" })).toBe("blocked");
    expect(updatedStatus({ title: "renamed" })).toBeUndefined();
  });
});

describe("closing comment of a finished task", () => {
  const closed = "2026-01-01T10:00:00.000Z";
  const old = { body: "earlier note", createdAt: "2026-01-01T09:00:00.000Z" };
  const final = { body: "the full report", createdAt: "2026-01-01T10:00:00.200Z" };
  const run = async (payload: Record<string, unknown>, replies: unknown[][]) => {
    const listComments = vi.fn(async () => replies[Math.min(listComments.mock.calls.length - 1, replies.length - 1)]);
    const ctx = { issues: { listComments } } as never;
    const body = await closingComment(ctx, { entityId: "i", companyId: "c", occurredAt: closed, payload } as never, { attempts: 4, waitMs: 1 });
    return { body, calls: listComments.mock.calls.length };
  };

  it("waits for the comment saved just after Paperclip closed the task", async () => {
    expect(await run({ toStatus: "done" }, [[], [old], [old, final]])).toEqual({ body: "the full report", calls: 3 });
  });

  it("does not wait when the status was set through the API", async () => {
    expect(await run({ status: "done" }, [[old]])).toEqual({ body: "earlier note", calls: 1 });
  });

  it("gives up after the last attempt and sends what there is", async () => {
    expect(await run({ toStatus: "done" }, [[old]])).toEqual({ body: "earlier note", calls: 4 });
    expect(await run({ toStatus: "done" }, [[]])).toEqual({ body: undefined, calls: 4 });
  });
});
