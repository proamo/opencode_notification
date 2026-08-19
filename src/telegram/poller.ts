import type { StateDatabase } from "../state";
import { TelegramApiError, type TelegramBotApi, type TelegramUpdate } from "./api";

export type UpdateDisposition = {
  disposition: "rejected" | "acknowledged" | "failed";
  actionId?: string;
  payloadHash?: string;
};

export type TelegramPollerOptions = {
  api: TelegramBotApi;
  database: StateDatabase;
  handleUpdate: (update: TelegramUpdate) => UpdateDisposition | Promise<UpdateDisposition>;
  longPollSeconds?: number;
  maxConsecutiveFailures?: number;
  retryMinDelayMs?: number;
  retryMaxDelayMs?: number;
  random?: () => number;
  now?: () => number;
};

export class TelegramPoller {
  readonly #api: TelegramBotApi;
  readonly #database: StateDatabase;
  readonly #handleUpdate: TelegramPollerOptions["handleUpdate"];
  readonly #longPollSeconds: number;
  readonly #maxConsecutiveFailures: number;
  readonly #retryMinDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #random: () => number;
  readonly #now: () => number;
  #controller: AbortController | undefined;
  #finished: Promise<void> | undefined;

  constructor(options: TelegramPollerOptions) {
    this.#api = options.api;
    this.#database = options.database;
    this.#handleUpdate = options.handleUpdate;
    this.#longPollSeconds = options.longPollSeconds ?? 30;
    this.#maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.#retryMinDelayMs = options.retryMinDelayMs ?? 500;
    this.#retryMaxDelayMs = options.retryMaxDelayMs ?? 30_000;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  get finished(): Promise<void> {
    return this.#finished ?? Promise.resolve();
  }

  async start(): Promise<void> {
    if (this.#finished) throw new Error("Telegram poller is already started");
    this.#controller = new AbortController();
    const signal = this.#controller.signal;

    const bot = await this.#retry(() => this.#api.getMe(signal), signal);
    this.#database.pinTelegramBotFingerprint(String(bot.id));
    await this.#retry(() => this.#api.deleteWebhook(signal), signal);
    this.#finished = this.#run(signal);
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    try {
      await this.#finished;
    } finally {
      this.#controller = undefined;
      this.#finished = undefined;
    }
  }

  async #run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const offset = this.#database.getTelegramUpdateOffset();
        const updates = await this.#api.getUpdates({
          offset,
          timeoutSeconds: this.#longPollSeconds,
          signal,
        });
        failures = 0;

        for (const update of [...updates].sort((left, right) => left.update_id - right.update_id)) {
          if (signal.aborted) return;
          if (update.update_id < this.#database.getTelegramUpdateOffset()) continue;
          const result = await this.#handleUpdate(update);
          this.#database.commitInboundUpdate({
            updateId: update.update_id,
            disposition: result.disposition,
            ...(result.actionId ? { actionId: result.actionId } : {}),
            ...(result.payloadHash ? { payloadHash: result.payloadHash } : {}),
            occurredAt: this.#now(),
          });
        }
      } catch (error) {
        if (signal.aborted) return;
        if (isTerminalTelegramError(error)) throw error;
        failures += 1;
        if (failures >= this.#maxConsecutiveFailures) throw error;
        await abortableDelay(this.#retryDelay(error, failures), signal);
      }
    }
  }

  async #retry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    let failures = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (signal.aborted || isTerminalTelegramError(error)) throw error;
        failures += 1;
        if (failures >= this.#maxConsecutiveFailures) throw error;
        await abortableDelay(this.#retryDelay(error, failures), signal);
      }
    }
  }

  #retryDelay(error: unknown, failures: number): number {
    if (error instanceof TelegramApiError && error.retryAfterSeconds) {
      return Math.min(this.#retryMaxDelayMs, error.retryAfterSeconds * 1_000);
    }
    const maximum = Math.min(
      this.#retryMaxDelayMs,
      this.#retryMinDelayMs * 2 ** Math.max(0, failures - 1),
    );
    return Math.floor(maximum * this.#random());
  }
}

function isTerminalTelegramError(error: unknown): boolean {
  return (
    error instanceof TelegramApiError &&
    (error.authenticationFailed || error.pollingConflict || !error.retryable)
  );
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
