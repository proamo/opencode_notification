import { z } from "zod";

const TranscriptionResponseSchema = z.object({
  text: z.string(),
});

export type VoiceTranscriberOptions = {
  apiKey: string;
  provider?: "groq" | "openai" | "custom";
  model?: string;
  endpoint?: string;
  language?: string;
  fetchFn?: typeof fetch;
};

export class VoiceTranscriber {
  readonly #apiKey: string;
  readonly #provider: "groq" | "openai" | "custom";
  readonly #model: string;
  readonly #endpoint: string;
  readonly #language: string;
  readonly #fetch: typeof fetch;

  constructor(options: VoiceTranscriberOptions) {
    this.#apiKey = options.apiKey.trim();
    this.#provider = options.provider ?? "groq";
    this.#language = options.language ?? "zh";
    this.#fetch = options.fetchFn ?? fetch;

    if (this.#provider === "groq") {
      this.#endpoint = options.endpoint ?? "https://api.groq.com/openai/v1/audio/transcriptions";
      this.#model = options.model ?? "whisper-large-v3-turbo";
    } else if (this.#provider === "openai") {
      this.#endpoint = options.endpoint ?? "https://api.openai.com/v1/audio/transcriptions";
      this.#model = options.model ?? "whisper-1";
    } else {
      this.#endpoint = options.endpoint ?? "https://api.groq.com/openai/v1/audio/transcriptions";
      this.#model = options.model ?? "whisper-large-v3-turbo";
    }
  }

  async transcribe(
    audioBuffer: Uint8Array,
    options?: {
      mimeType?: string;
      fileName?: string;
      promptHint?: string;
      signal?: AbortSignal;
    },
  ): Promise<string> {
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

    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: formData,
      signal: options?.signal,
    });

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

    return parsed.data.text.trim();
  }
}
