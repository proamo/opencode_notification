import { describe, expect, test } from "bun:test";
import { VoiceTranscriber } from "../src/telegram/transcriber";

describe("VoiceTranscriber", () => {
  test("transcribes audio buffer via Groq Whisper API", async () => {
    let requestedUrl = "";
    let requestedAuth = "";
    let formFields: Record<string, unknown> = {};

    const mockFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requestedUrl = String(input);
      requestedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";

      const body = init?.body as FormData;
      if (body) {
        formFields = {
          model: body.get("model"),
          language: body.get("language"),
          response_format: body.get("response_format"),
          prompt: body.get("prompt"),
        };
      }

      return new Response(
        JSON.stringify({
          text: "請幫我檢查爬蟲日誌是否有錯誤",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const transcriber = new VoiceTranscriber({
      apiKey: "gsk_test1234567890",
      provider: "groq",
      fetchFn: mockFetch,
    });

    const fakeAudio = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // Ogg header
    const result = await transcriber.transcribe(fakeAudio, {
      mimeType: "audio/ogg",
    });

    expect(result).toBe("請幫我檢查爬蟲日誌是否有錯誤");
    expect(requestedUrl).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(requestedAuth).toBe("Bearer gsk_test1234567890");
    expect(formFields.model).toBe("whisper-large-v3-turbo");
    expect(formFields.language).toBe("zh");
  });

  test("transcribes audio buffer via Cloudflare Workers AI", async () => {
    let requestedUrl = "";
    let requestedAuth = "";
    let requestedContentType = "";

    const mockFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requestedUrl = String(input);
      requestedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      requestedContentType = (init?.headers as Record<string, string>)?.["Content-Type"] ?? "";

      return new Response(
        JSON.stringify({
          result: {
            text: "系統狀態",
          },
          success: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const transcriber = new VoiceTranscriber({
      apiKey: "cfut_test_token_123",
      accountId: "test_account_id_456",
      provider: "cloudflare",
      fetchFn: mockFetch,
    });

    const fakeAudio = new Uint8Array([0x01, 0x02, 0x03]);
    const result = await transcriber.transcribe(fakeAudio);

    expect(result).toBe("系統狀態");
    expect(requestedUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test_account_id_456/ai/run/@cf/openai/whisper",
    );
    expect(requestedAuth).toBe("Bearer cfut_test_token_123");
    expect(requestedContentType).toBe("application/octet-stream");
  });

  test("handles transcription errors gracefully", async () => {
    const mockErrorFetch = (async (): Promise<Response> => {
      return new Response("Invalid API key provided", { status: 401 });
    }) as unknown as typeof fetch;

    const transcriber = new VoiceTranscriber({
      apiKey: "gsk_invalid",
      provider: "groq",
      fetchFn: mockErrorFetch,
    });

    const fakeAudio = new Uint8Array([0x00]);
    await expect(transcriber.transcribe(fakeAudio)).rejects.toThrow(
      "Voice transcription failed (401)",
    );
  });
});
