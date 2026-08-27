import { z } from "zod";

const TelegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  username: z.string().optional(),
});

const TelegramChatSchema = z.object({
  id: z.number().int(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
});

const TelegramVoiceSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string().optional(),
  duration: z.number().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
});

const TelegramAudioSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string().optional(),
  duration: z.number().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
  file_name: z.string().optional(),
});

const TelegramMessageSchema = z.object({
  message_id: z.number().int(),
  from: TelegramUserSchema.optional(),
  chat: TelegramChatSchema,
  date: z.number().int(),
  text: z.string().optional(),
  voice: TelegramVoiceSchema.optional(),
  audio: TelegramAudioSchema.optional(),
  sender_chat: TelegramChatSchema.optional(),
  forward_origin: z.unknown().optional(),
  author_signature: z.string().optional(),
  business_connection_id: z.string().optional(),
  reply_to_message: z
    .object({
      message_id: z.number().int(),
      chat: TelegramChatSchema,
    })
    .optional(),
});

const TelegramCallbackQuerySchema = z.object({
  id: z.string(),
  from: TelegramUserSchema,
  message: TelegramMessageSchema.optional(),
  data: z.string().optional(),
});

export const TelegramFileSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string().optional(),
  file_size: z.number().optional(),
  file_path: z.string().optional(),
});
export type TelegramFile = z.infer<typeof TelegramFileSchema>;

export const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: TelegramMessageSchema.optional(),
  callback_query: TelegramCallbackQuerySchema.optional(),
});
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

export const TelegramBotSchema = TelegramUserSchema.extend({ is_bot: z.literal(true) });
export type TelegramBot = z.infer<typeof TelegramBotSchema>;

export type SendMessageInput = {
  chatId: string;
  text: string;
  parseMode?: "HTML";
  disableNotification?: boolean;
  replyMarkup?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type TelegramBotApiOptions = {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

export class TelegramBotApi {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: TelegramBotApiOptions) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(options.token)) {
      throw new Error("Telegram bot token format is invalid");
    }
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
    this.#fetch = options.fetch ?? fetch;
  }

  async getMe(signal?: AbortSignal): Promise<TelegramBot> {
    return await this.#call("getMe", {}, TelegramBotSchema, signal);
  }

  async deleteWebhook(signal?: AbortSignal): Promise<void> {
    await this.#call("deleteWebhook", { drop_pending_updates: false }, z.literal(true), signal);
  }

  async getUpdates(input: {
    offset: number;
    timeoutSeconds?: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]> {
    return await this.#call(
      "getUpdates",
      {
        offset: input.offset,
        timeout: input.timeoutSeconds ?? 30,
        allowed_updates: ["message", "callback_query"],
      },
      z.array(TelegramUpdateSchema),
      input.signal,
    );
  }

  async sendMessage(input: SendMessageInput): Promise<{ messageId: number; chatId: string }> {
    const message = await this.#call(
      "sendMessage",
      {
        chat_id: input.chatId,
        text: input.text,
        ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
        ...(input.disableNotification !== undefined
          ? { disable_notification: input.disableNotification }
          : {}),
        ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
      },
      TelegramMessageSchema,
      input.signal,
    );
    return { messageId: message.message_id, chatId: String(message.chat.id) };
  }

  async answerCallbackQuery(input: {
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
    signal?: AbortSignal;
  }): Promise<boolean> {
    return await this.#call(
      "answerCallbackQuery",
      {
        callback_query_id: input.callbackQueryId,
        ...(input.text ? { text: input.text } : {}),
        ...(input.showAlert !== undefined ? { show_alert: input.showAlert } : {}),
      },
      z.boolean(),
      input.signal,
    );
  }

  async editMessageText(input: {
    chatId: string;
    messageId: number;
    text: string;
    parseMode?: "HTML";
    replyMarkup?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<{ messageId: number; chatId: string }> {
    const message = await this.#call(
      "editMessageText",
      {
        chat_id: input.chatId,
        message_id: input.messageId,
        text: input.text,
        ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
        ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
      },
      TelegramMessageSchema,
      input.signal,
    );
    return { messageId: message.message_id, chatId: String(message.chat.id) };
  }

  async getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile> {
    return await this.#call("getFile", { file_id: fileId }, TelegramFileSchema, signal);
  }

  async downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    const url = `https://api.telegram.org/file/bot${this.#token}/${filePath}`;
    const response = await this.#fetch(url, { signal });
    if (!response.ok) {
      throw new TelegramApiError({
        method: "downloadFile",
        statusCode: response.status,
        description: `Failed to download file from Telegram: ${response.statusText}`,
        retryable: response.status >= 500,
      });
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async #call<T>(
    method: string,
    body: Record<string, unknown>,
    resultSchema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/bot${this.#token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TelegramApiError({
        method,
        statusCode: 0,
        description: "Telegram request failed before receiving a response",
        retryable: true,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramApiError({
        method,
        statusCode: response.status,
        description: "Telegram returned an invalid JSON response",
        retryable: response.status >= 500,
      });
    }

    const envelope = TelegramResponseSchema.safeParse(payload);
    if (!envelope.success) {
      throw new TelegramApiError({
        method,
        statusCode: response.status,
        description: "Telegram returned an invalid API envelope",
        retryable: response.status >= 500,
      });
    }
    if (!envelope.data.ok) {
      throw new TelegramApiError({
        method,
        statusCode: response.status,
        errorCode: envelope.data.error_code,
        description: envelope.data.description,
        ...(envelope.data.parameters?.retry_after
          ? { retryAfterSeconds: envelope.data.parameters.retry_after }
          : {}),
        retryable:
          envelope.data.error_code === 429 ||
          envelope.data.error_code >= 500 ||
          response.status >= 500,
      });
    }

    const result = resultSchema.safeParse(envelope.data.result);
    if (!result.success) {
      throw new TelegramApiError({
        method,
        statusCode: response.status,
        description: "Telegram result did not match the expected contract",
        retryable: false,
      });
    }
    return result.data;
  }
}

const TelegramResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error_code: z.number().int(),
    description: z.string(),
    parameters: z.object({ retry_after: z.number().int().positive().optional() }).optional(),
  }),
]);

export class TelegramApiError extends Error {
  readonly method: string;
  readonly statusCode: number;
  readonly errorCode: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly retryable: boolean;

  constructor(input: {
    method: string;
    statusCode: number;
    errorCode?: number;
    description: string;
    retryAfterSeconds?: number;
    retryable: boolean;
  }) {
    super(input.description.slice(0, 256));
    this.name = "TelegramApiError";
    this.method = input.method;
    this.statusCode = input.statusCode;
    this.errorCode = input.errorCode;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.retryable = input.retryable;
  }

  get authenticationFailed(): boolean {
    return this.statusCode === 401 || this.errorCode === 401;
  }

  get pollingConflict(): boolean {
    return this.statusCode === 409 || this.errorCode === 409;
  }
}
