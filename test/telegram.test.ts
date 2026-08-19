import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../src/state";
import {
  createAuthorizedUpdateHandler,
  TelegramApiError,
  TelegramBotApi,
  TelegramOutboxWorker,
  TelegramPoller,
  TelegramUpdateAuthorizer,
} from "../src/telegram";

const TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz_ABCD";
const temporaryDirectories: string[] = [];
const databases: StateDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("TelegramBotApi", () => {
  test("calls getMe, deleteWebhook, getUpdates, and sendMessage with JSON bodies", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const api = createApi(async (method, body) => {
      requests.push({ method, body });
      if (method === "getMe") return ok(bot(42));
      if (method === "deleteWebhook") return ok(true);
      if (method === "getUpdates") return ok([update(7, "hello")]);
      return ok(message(99, 123456789, "sent"));
    });

    expect((await api.getMe()).id).toBe(42);
    await api.deleteWebhook();
    expect((await api.getUpdates({ offset: 7, timeoutSeconds: 20 }))[0]?.update_id).toBe(7);
    expect(
      await api.sendMessage({
        chatId: "123456789",
        text: "safe text",
        parseMode: "HTML",
        disableNotification: true,
      }),
    ).toEqual({ messageId: 99, chatId: "123456789" });

    expect(requests).toEqual([
      { method: "getMe", body: {} },
      { method: "deleteWebhook", body: { drop_pending_updates: false } },
      {
        method: "getUpdates",
        body: { offset: 7, timeout: 20, allowed_updates: ["message", "callback_query"] },
      },
      {
        method: "sendMessage",
        body: {
          chat_id: "123456789",
          text: "safe text",
          parse_mode: "HTML",
          disable_notification: true,
        },
      },
    ]);
  });

  test("classifies rate limits, authentication errors, conflicts, and server errors", async () => {
    for (const [code, expected] of [
      [429, { retryable: true, authenticationFailed: false, pollingConflict: false }],
      [401, { retryable: false, authenticationFailed: true, pollingConflict: false }],
      [409, { retryable: false, authenticationFailed: false, pollingConflict: true }],
      [500, { retryable: true, authenticationFailed: false, pollingConflict: false }],
    ] as const) {
      const api = createApi(async () =>
        failed(code, code === 429 ? { retry_after: 3 } : undefined),
      );
      const error = await api.getMe().catch((caught) => caught);
      expect(error).toBeInstanceOf(TelegramApiError);
      expect(error).toMatchObject(expected);
      if (code === 429) expect(error.retryAfterSeconds).toBe(3);
    }
  });

  test("does not expose the bot token through API errors", async () => {
    const api = createApi(async () => new Response("not json", { status: 502 }));
    const error = await api.getMe().then(
      () => undefined,
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected Telegram API error");
    expect(error.message).not.toContain(TOKEN);
    expect(String(error.stack)).not.toContain(TOKEN);
  });
});

describe("TelegramPoller", () => {
  test("pins the bot and commits updates sequentially before advancing offset", async () => {
    const database = await createDatabase();
    const handled: number[] = [];
    let updateCalls = 0;
    const api = createApi(async (method, _body, signal) => {
      if (method === "getMe") return ok(bot(42));
      if (method === "deleteWebhook") return ok(true);
      updateCalls += 1;
      if (updateCalls === 1) return ok([update(6, "second"), update(5, "first")]);
      return await waitForAbort(signal);
    });
    const poller = new TelegramPoller({
      api,
      database,
      handleUpdate: async (item) => {
        handled.push(item.update_id);
        await Bun.sleep(1);
        return { disposition: "acknowledged", payloadHash: `hash-${item.update_id}` };
      },
      retryMinDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    await poller.start();
    await waitUntil(() => handled.length === 2);
    await poller.stop();

    expect(handled).toEqual([5, 6]);
    expect(database.getTelegramUpdateOffset()).toBe(7);
    expect(database.getTelegramBotFingerprint()).toBe("42");
  });

  test("retries transient polling failures with a bound and then continues", async () => {
    const database = await createDatabase();
    let updateCalls = 0;
    let handled = 0;
    const api = createApi(async (method, _body, signal) => {
      if (method === "getMe") return ok(bot(42));
      if (method === "deleteWebhook") return ok(true);
      updateCalls += 1;
      if (updateCalls <= 2) return failed(500);
      if (updateCalls === 3) return ok([update(1, "recovered")]);
      return await waitForAbort(signal);
    });
    const poller = new TelegramPoller({
      api,
      database,
      handleUpdate: () => {
        handled += 1;
        return { disposition: "acknowledged" };
      },
      maxConsecutiveFailures: 3,
      retryMinDelayMs: 1,
      retryMaxDelayMs: 1,
      random: () => 0,
    });

    await poller.start();
    await waitUntil(() => handled === 1);
    await poller.stop();

    expect(updateCalls).toBe(4);
    expect(database.getTelegramUpdateOffset()).toBe(2);
  });

  test("stops on polling conflict without consuming an update", async () => {
    const database = await createDatabase();
    const api = createApi(async (method) => {
      if (method === "getMe") return ok(bot(42));
      if (method === "deleteWebhook") return ok(true);
      return failed(409);
    });
    const poller = new TelegramPoller({
      api,
      database,
      handleUpdate: () => ({ disposition: "acknowledged" }),
      retryMinDelayMs: 1,
    });

    await poller.start();
    const error = await poller.finished.catch((caught) => caught);

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error.pollingConflict).toBe(true);
    expect(database.getTelegramUpdateOffset()).toBe(0);
    await expect(poller.stop()).rejects.toBe(error);
  });

  test("refuses a token that resolves to a different bot identity", async () => {
    const database = await createDatabase();
    database.pinTelegramBotFingerprint("41");
    let deleteWebhookCalled = false;
    const api = createApi(async (method) => {
      if (method === "getMe") return ok(bot(42));
      if (method === "deleteWebhook") deleteWebhookCalled = true;
      return ok(true);
    });
    const poller = new TelegramPoller({
      api,
      database,
      handleUpdate: () => ({ disposition: "acknowledged" }),
    });

    await expect(poller.start()).rejects.toThrow("pinned bot identity");
    expect(deleteWebhookCalled).toBe(false);
    expect(database.getTelegramBotFingerprint()).toBe("41");
  });

  test("commits unauthorized updates as rejected without invoking session handling", async () => {
    const database = await createDatabase();
    let updateCalls = 0;
    let authorizedCalls = 0;
    const unauthorized = update(1, "sensitive command");
    if (unauthorized.message?.from) unauthorized.message.from.id = 999;
    const api = createApi(async (method, _body, signal) => {
      if (method === "getMe") return ok(bot(42));
      if (method === "deleteWebhook") return ok(true);
      updateCalls += 1;
      if (updateCalls === 1) return ok([unauthorized]);
      return await waitForAbort(signal);
    });
    const handler = createAuthorizedUpdateHandler(
      new TelegramUpdateAuthorizer({ userId: String(123456789), chatId: String(123456789) }),
      () => {
        authorizedCalls += 1;
        return { disposition: "acknowledged" };
      },
    );
    const poller = new TelegramPoller({ api, database, handleUpdate: handler });

    await poller.start();
    await waitUntil(() => database.getTelegramUpdateOffset() === 2);
    await poller.stop();

    expect(authorizedCalls).toBe(0);
    expect(database.inspect().inboundUpdates).toBe(1);
  });
});

describe("TelegramOutboxWorker", () => {
  test("honors retry_after and bounds outbound delivery attempts", async () => {
    const database = await createDatabase();
    database.enqueueOutbox({
      idempotencyKey: "event_1",
      chatId: "123456789",
      payload: JSON.stringify({ text: "redacted notification", parseMode: "HTML" }),
      priority: 10,
      nextAttemptAt: 1_000,
      expiresAt: 10_000,
      createdAt: 1_000,
    });
    let sends = 0;
    const api = createApi(async (method) => {
      if (method !== "sendMessage") throw new Error("unexpected method");
      sends += 1;
      return sends === 1 ? failed(429, { retry_after: 3 }) : ok(message(9, 123456789, "ok"));
    });
    const worker = new TelegramOutboxWorker({
      api,
      database,
      maxAttempts: 3,
      retryMinDelayMs: 1,
      random: () => 0,
    });

    expect(await worker.deliverBatch(1_000)).toBe(1);
    expect(database.inspect().outbox.retry).toBe(1);
    expect(database.nextOutbox(3_999, 10)).toHaveLength(0);
    expect(await worker.deliverBatch(4_000)).toBe(1);
    expect(database.inspect().outbox.delivered).toBe(1);
    expect(sends).toBe(2);
  });

  test("fails malformed payloads without sending them", async () => {
    const database = await createDatabase();
    database.enqueueOutbox({
      idempotencyKey: "event_1",
      chatId: "123456789",
      payload: "raw session output is not an allowed payload",
      priority: 1,
      nextAttemptAt: 1_000,
      expiresAt: 10_000,
      createdAt: 1_000,
    });
    let called = false;
    const worker = new TelegramOutboxWorker({
      api: createApi(async () => {
        called = true;
        return ok(message(1, 123456789, "unexpected"));
      }),
      database,
    });

    expect(await worker.deliverBatch(1_000)).toBe(1);
    expect(called).toBe(false);
    expect(database.inspect().outbox.failed).toBe(1);
  });

  test("redacts payload text again immediately before delivery", async () => {
    const database = await createDatabase();
    database.enqueueOutbox({
      idempotencyKey: "event_1",
      chatId: "123456789",
      payload: JSON.stringify({
        text: "token=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
        parseMode: "HTML",
      }),
      priority: 1,
      nextAttemptAt: 1_000,
      expiresAt: 10_000,
      createdAt: 1_000,
    });
    const sends: Record<string, unknown>[] = [];
    const worker = new TelegramOutboxWorker({
      api: createApi(async (method, body) => {
        if (method !== "sendMessage") throw new Error("unexpected method");
        sends.push(body);
        return ok(message(1, 123456789, "ok"));
      }),
      database,
    });

    expect(await worker.deliverBatch(1_000)).toBe(1);
    expect(sends[0]?.text).toBe("[redacted]");
  });

  test("persists actionable message bindings and opaque callback tokens after delivery", async () => {
    const database = await createDatabase();
    const route = {
      machineId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      projectId: "opaque-project-id",
      sessionId: "ses_123",
      routeGeneration: crypto.randomUUID(),
    };
    database.enqueueOutbox({
      idempotencyKey: "event_1",
      chatId: "123456789",
      payload: JSON.stringify({
        text: "Choose one",
        binding: {
          route,
          kind: "question_reply",
          interactionId: "question_1",
          expiresAt: 10_000,
          callbackButtons: [{ text: "Option A", action: "question.option", payload: "0:0" }],
        },
      }),
      priority: 10,
      nextAttemptAt: 1_000,
      expiresAt: 10_000,
      createdAt: 1_000,
    });
    const sends: Record<string, unknown>[] = [];
    const worker = new TelegramOutboxWorker({
      api: createApi(async (method, body) => {
        if (method !== "sendMessage") throw new Error("unexpected method");
        sends.push(body);
        return ok(message(77, 123456789, "ok"));
      }),
      database,
    });

    expect(await worker.deliverBatch(2_000)).toBe(1);
    const replyMarkup = sends[0]?.reply_markup as
      | { inline_keyboard?: Array<Array<{ callback_data?: string; text?: string }>> }
      | undefined;
    const token = replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(database.getMessageRoute("123456789", 77)).toMatchObject({
      kind: "question_reply",
      interactionId: "question_1",
      route,
      status: "active",
    });
    if (!token) throw new Error("expected callback token");
    expect(database.getCallbackToken(token)).toMatchObject({
      chatId: "123456789",
      messageId: 77,
      action: "question.option",
      payload: "0:0",
    });
  });

  test("does not persist bindings when Telegram delivery fails", async () => {
    const database = await createDatabase();
    database.enqueueOutbox({
      idempotencyKey: "event_1",
      chatId: "123456789",
      payload: JSON.stringify({
        text: "Choose one",
        binding: {
          route: {
            machineId: crypto.randomUUID(),
            instanceId: crypto.randomUUID(),
            projectId: "opaque-project-id",
            sessionId: "ses_123",
            routeGeneration: crypto.randomUUID(),
          },
          kind: "question_reply",
          interactionId: "question_1",
          expiresAt: 10_000,
          callbackButtons: [{ text: "Option A", action: "question.option", payload: "0:0" }],
        },
      }),
      priority: 10,
      nextAttemptAt: 1_000,
      expiresAt: 10_000,
      createdAt: 1_000,
    });
    const worker = new TelegramOutboxWorker({
      api: createApi(async () => failed(400)),
      database,
    });

    expect(await worker.deliverBatch(2_000)).toBe(1);
    expect(database.inspect().messageRoutes.active).toBe(0);
    expect(database.inspect().callbackTokens).toBe(0);
    expect(database.inspect().outbox.failed).toBe(1);
  });
});

function createApi(
  responder: (
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) => Response | Promise<Response>,
): TelegramBotApi {
  return new TelegramBotApi({
    token: TOKEN,
    baseUrl: "https://telegram.invalid",
    fetch: (async (input, init) => {
      const method = String(input).split("/").at(-1) ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return await responder(method, body, init?.signal ?? undefined);
    }) as typeof fetch,
  });
}

function ok(result: unknown): Response {
  return Response.json({ ok: true, result });
}

function failed(code: number, parameters?: { retry_after: number }): Response {
  return Response.json(
    {
      ok: false,
      error_code: code,
      description: `Telegram error ${code}`,
      ...(parameters ? { parameters } : {}),
    },
    { status: code },
  );
}

function bot(id: number) {
  return { id, is_bot: true, first_name: "Test Bot", username: "test_bot" };
}

function message(messageId: number, chatId: number, text: string) {
  return {
    message_id: messageId,
    chat: { id: chatId, type: "private" },
    date: 1_700_000_000,
    text,
  };
}

function update(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      ...message(updateId, 123456789, text),
      from: { id: 123456789, is_bot: false, first_name: "User" },
    },
  };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<Response> {
  if (!signal) throw new Error("expected abort signal");
  return await new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function createDatabase(): Promise<StateDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-telegram-api-"));
  temporaryDirectories.push(directory);
  const database = await StateDatabase.open({
    stateDirectory: directory,
    machineId: crypto.randomUUID(),
  });
  databases.push(database);
  return database;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(5);
  }
}
