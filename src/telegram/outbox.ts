import { z } from "zod";
import type { StateDatabase } from "../state";
import { TelegramApiError, type TelegramBotApi } from "./api";

export const TelegramOutboxPayloadSchema = z.object({
  text: z.string().min(1).max(4096),
  parseMode: z.literal("HTML").optional(),
  disableNotification: z.boolean().optional(),
  replyMarkup: z.record(z.string(), z.unknown()).optional(),
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
        await this.#api.sendMessage({
          chatId: record.chatId,
          text: payload.data.text,
          ...(payload.data.parseMode ? { parseMode: payload.data.parseMode } : {}),
          ...(payload.data.disableNotification !== undefined
            ? { disableNotification: payload.data.disableNotification }
            : {}),
          ...(payload.data.replyMarkup ? { replyMarkup: payload.data.replyMarkup } : {}),
        });
        this.#database.finishOutbox(record.id, "delivered", null, now);
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
