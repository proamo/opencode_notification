import { randomBytes } from "node:crypto";
import { z } from "zod";
import { RouteKeySchema } from "../protocol";
import type { CallbackTokenRecord, StateDatabase } from "../state";
import { TelegramApiError, type TelegramBotApi } from "./api";
import { sanitizeTelegramText } from "./render";

const MessageRouteKindSchema = z.enum([
  "session_prompt",
  "question_reply",
  "permission_notice",
  "informational",
]);

const CallbackButtonSchema = z.object({
  text: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
  payload: z.string().max(512).optional(),
});

export const TelegramOutboxPayloadSchema = z
  .object({
    text: z.string().min(1).max(4096),
    parseMode: z.literal("HTML").optional(),
    disableNotification: z.boolean().optional(),
    replyMarkup: z.record(z.string(), z.unknown()).optional(),
    binding: z
      .object({
        route: RouteKeySchema,
        kind: MessageRouteKindSchema,
        interactionId: z.string().min(1).max(256).optional(),
        expiresAt: z.number().int().nonnegative(),
        callbackButtons: z.array(CallbackButtonSchema).max(100).optional(),
      })
      .optional(),
  })
  .superRefine((payload, context) => {
    if (payload.replyMarkup && payload.binding?.callbackButtons?.length) {
      context.addIssue({
        code: "custom",
        message: "replyMarkup cannot be combined with callbackButtons",
        path: ["replyMarkup"],
      });
    }
  });
export type TelegramOutboxPayload = z.infer<typeof TelegramOutboxPayloadSchema>;

export type TelegramOutboxWorkerOptions = {
  api: TelegramBotApi;
  database: StateDatabase;
  maxAttempts?: number;
  retryMinDelayMs?: number;
  retryMaxDelayMs?: number;
  random?: () => number;
};

export class TelegramOutboxWorker {
  readonly #api: TelegramBotApi;
  readonly #database: StateDatabase;
  readonly #maxAttempts: number;
  readonly #retryMinDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #random: () => number;

  constructor(options: TelegramOutboxWorkerOptions) {
    this.#api = options.api;
    this.#database = options.database;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#retryMinDelayMs = options.retryMinDelayMs ?? 1_000;
    this.#retryMaxDelayMs = options.retryMaxDelayMs ?? 30_000;
    this.#random = options.random ?? Math.random;
  }

  async deliverBatch(now: number, limit = 20): Promise<number> {
    const records = this.#database.nextOutbox(now, limit);
    for (const record of records) {
      const payload = TelegramOutboxPayloadSchema.safeParse(parseJson(record.payload));
      if (!payload.success) {
        this.#database.finishOutbox(record.id, "failed", "INVALID_PAYLOAD", now);
        continue;
      }

      try {
        const text = sanitizeTelegramText(payload.data.text);
        if (!text) {
          this.#database.finishOutbox(record.id, "failed", "EMPTY_PAYLOAD", now);
          continue;
        }
        const prepared = preparePayload(payload.data);
        const message = await this.#api.sendMessage({
          chatId: record.chatId,
          text,
          ...(payload.data.parseMode ? { parseMode: payload.data.parseMode } : {}),
          ...(payload.data.disableNotification !== undefined
            ? { disableNotification: payload.data.disableNotification }
            : {}),
          ...(prepared.replyMarkup ? { replyMarkup: prepared.replyMarkup } : {}),
        });
        if (payload.data.binding) {
          this.#database.finishOutboxDeliveryWithBinding({
            outboxId: record.id,
            route: {
              chatId: message.chatId,
              messageId: message.messageId,
              route: payload.data.binding.route,
              kind: payload.data.binding.kind,
              ...(payload.data.binding.interactionId
                ? { interactionId: payload.data.binding.interactionId }
                : {}),
              createdAt: now,
              expiresAt: payload.data.binding.expiresAt,
              status: "active",
            },
            callbackTokens: prepared.tokens.map((token) => ({
              ...token,
              chatId: message.chatId,
              messageId: message.messageId,
              createdAt: now,
              expiresAt: payload.data.binding?.expiresAt ?? now,
            })),
            now,
          });
        } else {
          this.#database.finishOutbox(record.id, "delivered", null, now);
        }
      } catch (error) {
        const attempts = record.attempts + 1;
        if (
          error instanceof TelegramApiError &&
          error.retryable &&
          attempts < this.#maxAttempts &&
          record.expiresAt > now
        ) {
          this.#database.recordOutboxRetry(
            record.id,
            now + this.#retryDelay(error, attempts),
            telegramResultCode(error),
            now,
          );
        } else {
          this.#database.finishOutbox(
            record.id,
            "failed",
            error instanceof TelegramApiError ? telegramResultCode(error) : "DELIVERY_FAILED",
            now,
          );
        }
      }
    }
    return records.length;
  }

  #retryDelay(error: TelegramApiError, attempts: number): number {
    if (error.retryAfterSeconds) {
      return Math.min(this.#retryMaxDelayMs, error.retryAfterSeconds * 1_000);
    }
    const maximum = Math.min(
      this.#retryMaxDelayMs,
      this.#retryMinDelayMs * 2 ** Math.max(0, attempts - 1),
    );
    return Math.floor(maximum * this.#random());
  }
}

function preparePayload(payload: TelegramOutboxPayload): {
  replyMarkup?: Record<string, unknown>;
  tokens: Array<Omit<CallbackTokenRecord, "chatId" | "messageId" | "createdAt" | "expiresAt">>;
} {
  const buttons = payload.binding?.callbackButtons;
  if (!buttons?.length)
    return { ...(payload.replyMarkup ? { replyMarkup: payload.replyMarkup } : {}), tokens: [] };

  const tokens = buttons.map((button) => ({
    token: randomToken(),
    action: button.action,
    ...(button.payload ? { payload: button.payload } : {}),
  }));
  return {
    replyMarkup: {
      inline_keyboard: buttons.map((button, index) => [
        { text: button.text, callback_data: tokens[index]?.token },
      ]),
    },
    tokens,
  };
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function telegramResultCode(error: TelegramApiError): string {
  return error.errorCode ? `TELEGRAM_${error.errorCode}` : "TELEGRAM_TRANSPORT";
}
