// Speech-to-text against any OpenAI-compatible endpoint (POST <base>/audio/transcriptions).
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { normalizeSecretRef } from "./secret-ref-validation.js";

const TELEGRAM_API = "https://api.telegram.org";

export const DEFAULT_TRANSCRIPTION_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_TRANSCRIPTION_MODEL = "whisper-1";

export type TranscriptionConfig = {
  transcriptionApiKeyRef?: string;
  transcriptionBaseUrl?: string;
  transcriptionModel?: string;
  transcriptionLanguage?: string;
};

function baseUrlOf(config: TranscriptionConfig): string {
  return (config.transcriptionBaseUrl?.trim() || DEFAULT_TRANSCRIPTION_BASE_URL).replace(/\/+$/, "");
}

// OpenAI needs a key; a custom (for example self-hosted) endpoint may not.
export function isTranscriptionEnabled(config: TranscriptionConfig): boolean {
  return Boolean(config.transcriptionApiKeyRef) || baseUrlOf(config) !== DEFAULT_TRANSCRIPTION_BASE_URL;
}

export function validateTranscriptionConfig(config: Record<string, unknown>): string[] {
  const value = config.transcriptionBaseUrl;
  if (value === undefined || value === null || value === "") return [];
  try {
    const url = new URL(String(value));
    if (url.protocol === "http:" || url.protocol === "https:") return [];
  } catch {
    // reported below
  }
  return ["transcriptionBaseUrl must be an http(s) URL, for example http://127.0.0.1:8000/v1"];
}

export async function transcribeAudio(
  ctx: PluginContext,
  botToken: string,
  fileId: string,
  config: TranscriptionConfig,
  companyId: string,
): Promise<string | null> {
  // 1. Get file path from Telegram (JSON response — ctx.http.fetch works fine for this)
  const fileRes = await ctx.http.fetch(
    `${TELEGRAM_API}/bot${botToken}/getFile?file_id=${fileId}`,
    { method: "GET" },
  );
  const fileData = (await fileRes.json()) as { ok: boolean; result?: { file_path?: string } };
  if (!fileData.ok || !fileData.result?.file_path) {
    ctx.logger.error("Failed to get file path from Telegram", { fileId });
    return null;
  }

  // 2. Download binary audio using native fetch (bypasses RPC bridge UTF-8 corruption)
  const downloadUrl = `${TELEGRAM_API}/file/bot${botToken}/${fileData.result.file_path}`;
  const audioRes = await fetch(downloadUrl);
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

  // 3. Resolve the API key from Paperclip secrets, if one is configured
  const headers: Record<string, string> = {};
  if (config.transcriptionApiKeyRef) {
    const normalizedRef = normalizeSecretRef(config.transcriptionApiKeyRef);
    if (!normalizedRef) {
      ctx.logger.error("Invalid transcription API key secret reference", { companyId });
      return null;
    }
    const apiKey = await ctx.secrets.resolve(normalizedRef, {
      companyId,
      configPath: "transcriptionApiKeyRef",
    });
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // 4. Build multipart form data manually (native FormData + Blob works in Node 18+)
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "audio.ogg");
  formData.append("model", config.transcriptionModel?.trim() || DEFAULT_TRANSCRIPTION_MODEL);
  const language = config.transcriptionLanguage?.trim();
  if (language) formData.append("language", language);

  // 5. Native fetch: FormData can't be serialized through the RPC bridge, and a
  // self-hosted endpoint is usually on a private address the sandbox refuses.
  // The URL comes only from the plugin configuration, never from a message.
  const res = await fetch(`${baseUrlOf(config)}/audio/transcriptions`, {
    method: "POST",
    headers,
    body: formData,
  });
  if (res.ok === false) {
    throw new Error(`Transcription endpoint answered HTTP ${res.status}`);
  }

  const data = (await res.json()) as { text?: string };
  return data.text?.trim() || null;
}
