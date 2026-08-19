import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedNotification } from "../src/protocol";
import { StateDatabase } from "../src/state";
import { renderTelegramNotification, TelegramBotApi, TelegramPoller } from "../src/telegram";

const temporaryDirectories: string[] = [];
const databases: StateDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("recorded Telegram API fixtures", () => {
  test("sends a rendered completion notification through the recorded transport contract", async () => {
    const fixture = await loadFixture("send-message-completion.json");
    const api = createRecordedApi(fixture);

    expect((await api.getMe()).username).toBe("fixture_bot");
    const payload = renderTelegramNotification(completionNotification());
    const result = await api.sendMessage({ chatId: fixture.chatId ?? "123456789", ...payload });

    expect(result).toEqual({ messageId: 77, chatId: "123456789" });
    expect(fixture.calls).toHaveLength(0);
  });

  test("polls updates using recorded request and response fixtures", async () => {
    const fixture = await loadFixture("polling-updates.json");
    const database = await createDatabase();
    const handled: number[] = [];
    const poller = new TelegramPoller({
      api: createRecordedApi(fixture),
      database,
      longPollSeconds: 20,
      handleUpdate: (update) => {
        handled.push(update.update_id);
        return { disposition: "acknowledged" };
      },
      retryMinDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    await poller.start();
    await waitUntil(() => handled.length === 1);
    await poller.stop();

    expect(handled).toEqual([100]);
    expect(database.getTelegramUpdateOffset()).toBe(101);
    expect(fixture.calls).toHaveLength(0);
  });
});

type RecordedFixture = {
  token: string;
  chatId?: string;
  calls: Array<{
    method: string;
    expectBody: Record<string, unknown>;
    response: unknown;
  }>;
};

async function loadFixture(name: string): Promise<RecordedFixture> {
  const text = await readFile(join(import.meta.dir, "fixtures", "telegram", name), "utf8");
  return JSON.parse(text) as RecordedFixture;
}

function createRecordedApi(fixture: RecordedFixture): TelegramBotApi {
  return new TelegramBotApi({
    token: fixture.token,
    baseUrl: "https://telegram.invalid",
    fetch: (async (input, init) => {
      const url = String(input);
      expect(url).toStartWith(`https://telegram.invalid/bot${fixture.token}/`);
      const method = url.split("/").at(-1) ?? "";
      const call = fixture.calls.shift();
      if (!call) return await waitForAbort(init?.signal ?? undefined);
      expect(method).toBe(call.method);
      expect(JSON.parse(String(init?.body ?? "{}"))).toEqual(call.expectBody);
      return Response.json(call.response);
    }) as typeof fetch,
  });
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<Response> {
  if (!signal) throw new Error("expected abort signal");
  return await new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function completionNotification(): NormalizedNotification {
  return {
    kind: "session.completed",
    eventId: "event_1",
    route: {
      machineId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      projectId: "opaque-project-id-value",
      sessionId: "ses_123",
      routeGeneration: crypto.randomUUID(),
    },
    locale: "en",
    projectLabel: "backend-api",
    sessionLabel: "Implement notifications",
    occurredAt: "2026-08-19T12:00:00.000Z",
  };
}

async function createDatabase(): Promise<StateDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-telegram-contract-"));
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
