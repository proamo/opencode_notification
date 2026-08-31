import { describe, expect, test } from "bun:test";
import { TelegramApiError } from "../src/telegram/api";
import { TelegramPoller } from "../src/telegram/poller";

describe("Telegram Poller Resilience", () => {
  test("poller retries transient errors with backoff without terminating early", async () => {
    let attempts = 0;
    const fakeApi = {
      deleteWebhook: async () => {},
      getMe: async () => ({ id: 12345678, is_bot: true, first_name: "TestBot" }),
      getUpdates: async ({ signal }: { signal: AbortSignal }) => {
        attempts++;
        if (attempts < 5) {
          // Simulate 4 transient network drops / 502 Bad Gateways
          throw new TelegramApiError({
            method: "getUpdates",
            description: "Network timeout / Gateway error",
            statusCode: 502,
            retryable: true,
          });
        }
        if (signal.aborted) return [];
        return await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => resolveEmpty(), { once: true });
          function resolveEmpty() {
            reject(signal.reason);
          }
        });
      },
    } as unknown as ConstructorParameters<typeof TelegramPoller>[0]["api"];

    const fakeDb = {
      pinTelegramBotFingerprint: () => {},
      getTelegramUpdateOffset: () => 0,
      commitInboundUpdate: () => {},
    } as unknown as ConstructorParameters<typeof TelegramPoller>[0]["database"];

    const poller = new TelegramPoller({
      api: fakeApi,
      database: fakeDb,
      handleUpdate: async () => ({ disposition: "acknowledged" }),
      retryMinDelayMs: 1,
      retryMaxDelayMs: 2,
    });

    await poller.start();

    // Wait for retry loop to cycle through transient errors
    while (attempts < 5) {
      await Bun.sleep(10);
    }
    await poller.stop();

    // Verify it attempted multiple times and recovered rather than throwing after 3 failures
    expect(attempts).toBeGreaterThanOrEqual(5);
  });

  test("poller failure does not prevent graceful runtime and server shutdown", async () => {
    const fakeApi = {
      deleteWebhook: async () => {},
      getMe: async () => ({ id: 12345678, is_bot: true, first_name: "TestBot" }),
      getUpdates: async () => {
        throw new TelegramApiError({
          method: "getUpdates",
          description: "Conflict: terminated by other getUpdates request",
          statusCode: 409,
          retryable: false,
        });
      },
    } as unknown as ConstructorParameters<typeof TelegramPoller>[0]["api"];

    const fakeDb = {
      pinTelegramBotFingerprint: () => {},
      getTelegramUpdateOffset: () => 0,
      commitInboundUpdate: () => {},
    } as unknown as ConstructorParameters<typeof TelegramPoller>[0]["database"];

    const poller = new TelegramPoller({
      api: fakeApi,
      database: fakeDb,
      handleUpdate: async () => ({ disposition: "acknowledged" }),
      retryMinDelayMs: 1,
      retryMaxDelayMs: 2,
    });

    await poller.start();
    await poller.finished.catch(() => {});

    // Poller has failed with terminal error; poller.stop() rejection should be safe to catch
    let errorCaught = false;
    try {
      await poller.stop();
    } catch {
      errorCaught = true;
    }
    expect(errorCaught).toBe(true);
  });
});
