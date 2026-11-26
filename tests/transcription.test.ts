import { describe, it, expect, vi, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isTranscriptionEnabled, transcribeAudio, validateTranscriptionConfig } from "../src/transcription.js";

const KEY_REF = "11111111-1111-4111-8111-111111111111";

function setup(status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("api.telegram.org/file/")) return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    return { ok: status < 400, status, json: async () => ({ text: " hello " }) };
  }));
  const ctx = {
    http: { fetch: vi.fn(async () => ({ json: async () => ({ ok: true, result: { file_path: "voice/1.ogg" } }) })) },
    secrets: { resolve: vi.fn(async () => "sk-test") },
    logger: { error: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("transcription endpoint", () => {
  it("needs a key for the default endpoint but not for a custom one", () => {
    expect(isTranscriptionEnabled({})).toBe(false);
    expect(isTranscriptionEnabled({ transcriptionBaseUrl: "https://api.openai.com/v1/" })).toBe(false);
    expect(isTranscriptionEnabled({ transcriptionApiKeyRef: KEY_REF })).toBe(true);
    expect(isTranscriptionEnabled({ transcriptionBaseUrl: "http://127.0.0.1:8000/v1" })).toBe(true);
  });

  it("calls OpenAI with the key by default", async () => {
    const { ctx, calls } = setup();
    expect(await transcribeAudio(ctx, "t", "f", { transcriptionApiKeyRef: KEY_REF }, "c")).toBe("hello");
    const last = calls.at(-1)!;
    expect(last.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(last.init!.headers).toEqual({ Authorization: "Bearer sk-test" });
    expect((last.init!.body as FormData).get("model")).toBe("whisper-1");
    expect((last.init!.body as FormData).get("language")).toBeNull();
  });

  it("calls a custom endpoint with its model and language and no key", async () => {
    const { ctx, calls } = setup();
    await transcribeAudio(ctx, "t", "f", {
      transcriptionBaseUrl: "http://127.0.0.1:8000/v1/",
      transcriptionModel: "local-model",
      transcriptionLanguage: "en",
    }, "c");
    const last = calls.at(-1)!;
    expect(last.url).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
    expect(last.init!.headers).toEqual({});
    expect((last.init!.body as FormData).get("model")).toBe("local-model");
    expect((last.init!.body as FormData).get("language")).toBe("en");
  });

  it("reports an HTTP error", async () => {
    const { ctx } = setup(500);
    await expect(transcribeAudio(ctx, "t", "f", { transcriptionBaseUrl: "http://x/v1" }, "c")).rejects.toThrow("HTTP 500");
  });

  it("accepts only http(s) base URLs", () => {
    expect(validateTranscriptionConfig({})).toEqual([]);
    expect(validateTranscriptionConfig({ transcriptionBaseUrl: "http://localhost:8000/v1" })).toEqual([]);
    expect(validateTranscriptionConfig({ transcriptionBaseUrl: "file:///etc/passwd" })).toHaveLength(1);
    expect(validateTranscriptionConfig({ transcriptionBaseUrl: "nonsense" })).toHaveLength(1);
  });
});
