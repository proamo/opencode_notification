import { z } from "zod";

const TranscriptionResponseSchema = z.union([
  z.object({
    text: z.string(),
  }),
  z.object({
    result: z.object({
      text: z.string(),
    }),
    success: z.boolean().optional(),
  }),
]);

export type VoiceTranscriberOptions = {
  apiKey: string;
  accountId?: string | undefined;
  provider?: "groq" | "openai" | "cloudflare" | "custom" | undefined;
  model?: string | undefined;
  endpoint?: string | undefined;
  language?: string | undefined;
  fetchFn?: typeof fetch | undefined;
};

export class VoiceTranscriber {
  readonly #apiKey: string;
  readonly #accountId?: string | undefined;
  readonly #provider: "groq" | "openai" | "cloudflare" | "custom";
  readonly #model: string;
  readonly #endpoint: string;
  readonly #language: string;
  readonly #fetch: typeof fetch;

  constructor(options: VoiceTranscriberOptions) {
    this.#apiKey = options.apiKey.trim();
    this.#accountId = options.accountId?.trim();
    this.#provider = options.provider ?? "groq";
    this.#language = options.language ?? "zh";
    this.#fetch = options.fetchFn ?? fetch;

    if (this.#provider === "groq") {
      this.#endpoint = options.endpoint ?? "https://api.groq.com/openai/v1/audio/transcriptions";
      this.#model = options.model ?? "whisper-large-v3-turbo";
    } else if (this.#provider === "openai") {
      this.#endpoint = options.endpoint ?? "https://api.openai.com/v1/audio/transcriptions";
      this.#model = options.model ?? "whisper-1";
    } else if (this.#provider === "cloudflare") {
      const accountId = this.#accountId ?? "2fa0dd0cbd72565d704fb330d85ad604";
      this.#endpoint =
        options.endpoint ??
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/openai/whisper`;
      this.#model = options.model ?? "@cf/openai/whisper";
    } else {
      this.#endpoint = options.endpoint ?? "https://api.groq.com/openai/v1/audio/transcriptions";
      this.#model = options.model ?? "whisper-large-v3-turbo";
    }
  }

  async transcribe(
    audioBuffer: Uint8Array,
    options?: {
      mimeType?: string | undefined;
      fileName?: string | undefined;
      promptHint?: string | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<string> {
    const fetchOptions: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
      },
    };

    if (this.#provider === "cloudflare") {
      fetchOptions.headers = {
        ...fetchOptions.headers,
        "Content-Type": "application/octet-stream",
      };
      fetchOptions.body = audioBuffer;
    } else {
      const fileName = options?.fileName ?? "voice.ogg";
      const mimeType = options?.mimeType ?? "audio/ogg";
      const promptHint =
        options?.promptHint ??
        "OpenCode, /run, /status, /nodes, /sessions, /cancel, adspower-farm, FispERP, codeCenter, 爬蟲, 修復, 部署";

      const formData = new FormData();
      const blob = new Blob([audioBuffer], { type: mimeType });
      formData.append("file", blob, fileName);
      formData.append("model", this.#model);
      formData.append("language", this.#language);
      formData.append("response_format", "json");
      if (promptHint) {
        formData.append("prompt", promptHint);
      }
      fetchOptions.body = formData;
    }

    if (options?.signal) {
      fetchOptions.signal = options.signal;
    }

    const response = await this.#fetch(this.#endpoint, fetchOptions);

    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = await response.text();
      } catch {
        errorBody = response.statusText;
      }
      throw new Error(`Voice transcription failed (${response.status}): ${errorBody}`);
    }

    const json = (await response.json()) as unknown;
    const parsed = TranscriptionResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error("Invalid transcription response from speech provider");
    }

    if ("result" in parsed.data) {
      return parsed.data.result.text.trim();
    }
    return parsed.data.text.trim();
  }
}
