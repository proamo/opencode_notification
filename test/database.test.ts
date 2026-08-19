import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DatabaseVersionError,
  inspectDatabaseIntegrity,
  repairCorruptStateDatabase,
  StateDatabase,
} from "../src/state";

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

describe("StateDatabase", () => {
  test("creates the current schema in a private database", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const database = await openDatabase(stateDirectory);

    expect(database.schemaVersion).toBe(2);
    if (process.platform !== "win32") {
      expect((await stat(database.path)).mode & 0o777).toBe(0o600);
    }
  });

  test("rejects a database from a newer schema version", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const path = join(stateDirectory, "state.sqlite");
    const newer = new Database(path, { create: true });
    newer.exec("PRAGMA user_version = 99");
    newer.close(false);
    await chmod(path, 0o600);

    await expect(
      StateDatabase.open({ stateDirectory, machineId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(DatabaseVersionError);
  });

  test("migrates a v1 database to callback-token capable v2 state", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const path = join(stateDirectory, "state.sqlite");
    const machineId = crypto.randomUUID();
    const legacy = new Database(path, { create: true, strict: true });
    legacy.exec(LEGACY_SCHEMA_VERSION_1);
    legacy.query("INSERT INTO meta (key, value) VALUES ('machine_id', ?)").run(machineId);
    legacy
      .query(
        "INSERT INTO outbox (idempotency_key, chat_id, payload, priority, next_attempt_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("event_1", "123456789", "redacted payload", 1, 1_000, 10_000, 1_000, 1_000);
    legacy.close(false);
    await chmod(path, 0o600);

    const database = await StateDatabase.open({ stateDirectory, machineId });
    databases.push(database);

    expect(database.schemaVersion).toBe(2);
    expect(database.nextOutbox(1_000, 10)).toHaveLength(1);
    database.saveMessageRoute({
      chatId: "123456789",
      messageId: 1,
      route: {
        machineId,
        instanceId: crypto.randomUUID(),
        projectId: "opaque-project-id",
        sessionId: "ses_123",
        routeGeneration: crypto.randomUUID(),
      },
      kind: "informational",
      createdAt: 1_000,
      expiresAt: 2_000,
      status: "active",
    });
    database.saveCallbackToken({
      token: "opaque-token",
      chatId: "123456789",
      messageId: 1,
      action: "noop",
      createdAt: 1_000,
      expiresAt: 2_000,
    });
  });

  test.skipIf(process.platform === "win32")("rejects unsafe database permissions", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const path = join(stateDirectory, "state.sqlite");
    const unsafe = new Database(path, { create: true });
    unsafe.close(false);
    await chmod(path, 0o644);

    await expect(
      StateDatabase.open({ stateDirectory, machineId: crypto.randomUUID() }),
    ).rejects.toThrow("group or other access");
  });

  test("pins the database to one machine identity", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const machineId = crypto.randomUUID();
    const database = await StateDatabase.open({ stateDirectory, machineId });
    database.close();

    await expect(
      StateDatabase.open({ stateDirectory, machineId: crypto.randomUUID() }),
    ).rejects.toThrow("different machine identity");
  });

  test("commits update disposition and offset atomically and idempotently", async () => {
    const database = await openDatabase(await createTemporaryDirectory());

    expect(
      database.commitInboundUpdate({
        updateId: 41,
        disposition: "acknowledged",
        payloadHash: "hash-only",
        occurredAt: 1_000,
      }),
    ).toBe(true);
    expect(database.getTelegramUpdateOffset()).toBe(42);

    expect(
      database.commitInboundUpdate({
        updateId: 41,
        disposition: "failed",
        occurredAt: 2_000,
      }),
    ).toBe(false);
    expect(database.getTelegramUpdateOffset()).toBe(42);

    expect(
      database.commitInboundUpdate({
        updateId: 50,
        actionId: "action_1",
        disposition: "rejected",
        occurredAt: 3_000,
      }),
    ).toBe(true);
    expect(database.getTelegramUpdateOffset()).toBe(51);
  });

  test("persists exact Telegram message routes without session content", async () => {
    const database = await openDatabase(await createTemporaryDirectory());
    const route = {
      machineId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      projectId: "opaque-project-id",
      sessionId: "ses_123",
      routeGeneration: crypto.randomUUID(),
    };
    database.saveMessageRoute({
      chatId: "123456789",
      messageId: 77,
      route,
      kind: "question_reply",
      interactionId: "question_1",
      createdAt: 1_000,
      expiresAt: 2_000,
      status: "active",
    });

    expect(database.getMessageRoute("123456789", 77)).toEqual({
      chatId: "123456789",
      messageId: 77,
      route,
      kind: "question_reply",
      interactionId: "question_1",
      createdAt: 1_000,
      expiresAt: 2_000,
      status: "active",
    });
    expect(database.setMessageRouteStatus("123456789", 77, "consumed")).toBe(true);
    expect(database.getMessageRoute("123456789", 77)?.status).toBe("consumed");
  });

  test("persists delivered bindings and callback tokens atomically", async () => {
    const database = await openDatabase(await createTemporaryDirectory());
    const route = {
      machineId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      projectId: "opaque-project-id",
      sessionId: "ses_123",
      routeGeneration: crypto.randomUUID(),
    };
    const outbox = database.enqueueOutbox({
      idempotencyKey: "event_1",
      chatId: "123456789",
      payload: "redacted payload",
      priority: 1,
      nextAttemptAt: 1_000,
      expiresAt: 10_000,
      createdAt: 1_000,
    });

    database.finishOutboxDeliveryWithBinding({
      outboxId: outbox.id,
      route: {
        chatId: "123456789",
        messageId: 77,
        route,
        kind: "question_reply",
        interactionId: "question_1",
        createdAt: 2_000,
        expiresAt: 10_000,
        status: "active",
      },
      callbackTokens: [
        {
          token: "opaque-token",
          chatId: "123456789",
          messageId: 77,
          action: "question.option",
          payload: "0:1",
          createdAt: 2_000,
          expiresAt: 10_000,
        },
      ],
      now: 2_000,
    });

    expect(database.getMessageRoute("123456789", 77)).toMatchObject({
      kind: "question_reply",
      interactionId: "question_1",
      route,
    });
    expect(database.getCallbackToken("opaque-token")).toMatchObject({
      chatId: "123456789",
      messageId: 77,
      action: "question.option",
      payload: "0:1",
    });
    expect(database.inspect().outbox.delivered).toBe(1);
    expect(database.inspect().callbackTokens).toBe(1);
  });

  test("deduplicates and prioritizes the redacted outbound queue", async () => {
    const database = await openDatabase(await createTemporaryDirectory());
    const first = database.enqueueOutbox({
      idempotencyKey: "event_1",
      chatId: "123456789",
      payload: "redacted completion",
      priority: 1,
      nextAttemptAt: 1_000,
      expiresAt: 10_000,
      createdAt: 100,
    });
    const duplicate = database.enqueueOutbox({
      idempotencyKey: "event_1",
      chatId: "123456789",
      payload: "must not replace original",
      priority: 99,
      nextAttemptAt: 1_000,
      expiresAt: 10_000,
      createdAt: 200,
    });
    database.enqueueOutbox({
      idempotencyKey: "event_2",
      chatId: "123456789",
      payload: "redacted question",
      priority: 10,
      nextAttemptAt: 1_000,
      expiresAt: 10_000,
      createdAt: 200,
    });

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ id: first.id, created: false });
    expect(database.nextOutbox(1_000, 10).map((entry) => entry.idempotencyKey)).toEqual([
      "event_2",
      "event_1",
    ]);

    database.recordOutboxRetry(first.id, 5_000, "TELEGRAM_429", 2_000);
    expect(database.nextOutbox(2_000, 10).map((entry) => entry.idempotencyKey)).toEqual([
      "event_2",
    ]);
    database.finishOutbox(first.id, "delivered", null, 5_000);
    expect(database.nextOutbox(5_000, 10).map((entry) => entry.idempotencyKey)).toEqual([
      "event_2",
    ]);
  });

  test("allows an idempotency key to be reclaimed only after expiry", async () => {
    const database = await openDatabase(await createTemporaryDirectory());

    expect(database.claimNotification("event_1", 2_000, 1_000)).toBe(true);
    expect(database.claimNotification("event_1", 3_000, 1_500)).toBe(false);
    expect(database.claimNotification("event_1", 4_000, 2_000)).toBe(true);
  });

  test("expires records, enforces retention, and exposes metadata-only inspection", async () => {
    const database = await openDatabase(await createTemporaryDirectory());
    const route = {
      machineId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      projectId: "opaque-project-id",
      sessionId: "ses_123",
      routeGeneration: crypto.randomUUID(),
    };
    database.saveMessageRoute({
      chatId: "123456789",
      messageId: 1,
      route,
      kind: "session_prompt",
      createdAt: 900,
      expiresAt: 950,
      status: "active",
    });
    database.enqueueOutbox({
      idempotencyKey: "event_1",
      chatId: "123456789",
      payload: "redacted payload",
      priority: 1,
      nextAttemptAt: 900,
      expiresAt: 950,
      createdAt: 900,
    });
    database.commitInboundUpdate({
      updateId: 1,
      disposition: "acknowledged",
      occurredAt: 100,
    });
    database.claimNotification("expired-dedupe", 950, 900);

    const cleanup = database.cleanup(1_000, {
      terminalRouteRetentionMs: 1_000,
      terminalOutboxRetentionMs: 1_000,
      inboundUpdateRetentionMs: 500,
      maxMessageRoutes: 10,
      maxCallbackTokens: 10,
      maxOutboxRecords: 10,
      maxInboundUpdates: 10,
      maxDedupeRecords: 10,
    });
    const inspection = database.inspect();

    expect(cleanup).toEqual({
      expiredMessageRoutes: 1,
      expiredOutboxRecords: 1,
      deletedMessageRoutes: 0,
      deletedCallbackTokens: 0,
      deletedOutboxRecords: 0,
      deletedInboundUpdates: 1,
      deletedDedupeRecords: 1,
    });
    expect(inspection.messageRoutes.expired).toBe(1);
    expect(inspection.outbox.failed).toBe(1);
    expect(inspection.inboundUpdates).toBe(0);
    expect(inspection.dedupeRecords).toBe(0);
    expect(JSON.stringify(inspection)).not.toContain("redacted payload");
  });

  test("bounds table growth by deleting the oldest records", async () => {
    const database = await openDatabase(await createTemporaryDirectory());
    for (let index = 1; index <= 3; index += 1) {
      database.commitInboundUpdate({
        updateId: index,
        disposition: "acknowledged",
        occurredAt: index * 100,
      });
      database.claimNotification(`event_${index}`, 10_000 + index, 0);
    }

    const cleanup = database.cleanup(1_000, {
      terminalRouteRetentionMs: 10_000,
      terminalOutboxRetentionMs: 10_000,
      inboundUpdateRetentionMs: 10_000,
      maxMessageRoutes: 0,
      maxCallbackTokens: 0,
      maxOutboxRecords: 0,
      maxInboundUpdates: 2,
      maxDedupeRecords: 2,
    });

    expect(cleanup.deletedInboundUpdates).toBe(1);
    expect(cleanup.deletedDedupeRecords).toBe(1);
    expect(database.inspect().inboundUpdates).toBe(2);
    expect(database.inspect().dedupeRecords).toBe(2);
    expect(database.getTelegramUpdateOffset()).toBe(4);
  });

  test("purges operational state while preserving schema and machine identity", async () => {
    const database = await openDatabase(await createTemporaryDirectory());
    database.commitInboundUpdate({
      updateId: 8,
      disposition: "rejected",
      occurredAt: 1_000,
    });
    database.claimNotification("event_1", 2_000, 1_000);
    const machineId = database.inspect().machineId;

    const removed = database.purgeOperationalState();

    expect(removed.inboundUpdates).toBe(1);
    expect(removed.dedupeRecords).toBe(1);
    expect(database.inspect().machineId).toBe(machineId);
    expect(database.inspect().schemaVersion).toBe(2);
    expect(database.getTelegramUpdateOffset()).toBe(0);
  });

  test("requires explicit repair and refuses to replace a healthy database", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const machineId = crypto.randomUUID();
    const database = await StateDatabase.open({ stateDirectory, machineId });
    database.close();

    expect(await inspectDatabaseIntegrity(stateDirectory)).toEqual({ status: "healthy" });
    await expect(
      repairCorruptStateDatabase({ stateDirectory, machineId, confirm: false }),
    ).rejects.toThrow("explicit confirmation");
    await expect(
      repairCorruptStateDatabase({ stateDirectory, machineId, confirm: true }),
    ).rejects.toThrow("database is healthy");
  });

  test("archives a corrupt database only through explicit repair", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const path = join(stateDirectory, "state.sqlite");
    await Bun.write(path, "not a sqlite database");
    await chmod(path, 0o600);
    const machineId = crypto.randomUUID();

    expect((await inspectDatabaseIntegrity(stateDirectory)).status).toBe("corrupt");
    const result = await repairCorruptStateDatabase({
      stateDirectory,
      machineId,
      confirm: true,
    });

    expect(result.previousIntegrity.status).toBe("corrupt");
    expect(await Bun.file(result.archivePath).text()).toBe("not a sqlite database");
    expect(await inspectDatabaseIntegrity(stateDirectory)).toEqual({ status: "healthy" });
    const replacement = await StateDatabase.open({ stateDirectory, machineId });
    expect(replacement.inspect().machineId).toBe(machineId);
    replacement.close();
  });
});

async function openDatabase(stateDirectory: string): Promise<StateDatabase> {
  const database = await StateDatabase.open({
    stateDirectory,
    machineId: crypto.randomUUID(),
  });
  databases.push(database);
  return database;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-telegram-db-"));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

const LEGACY_SCHEMA_VERSION_1 = `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE message_routes (
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    machine_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    route_generation TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('session_prompt', 'question_reply', 'permission_notice', 'informational')),
    interaction_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired', 'offline')),
    PRIMARY KEY (chat_id, message_id)
  ) STRICT;
  CREATE INDEX message_routes_expiry ON message_routes(status, expires_at);
  CREATE INDEX message_routes_route ON message_routes(machine_id, instance_id, project_id, session_id, route_generation);

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    priority INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retry', 'delivered', 'failed')),
    result_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX outbox_delivery ON outbox(status, next_attempt_at, priority, created_at);

  CREATE TABLE inbound_updates (
    update_id INTEGER PRIMARY KEY,
    action_id TEXT,
    disposition TEXT NOT NULL CHECK (disposition IN ('rejected', 'acknowledged', 'failed')),
    payload_hash TEXT,
    occurred_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE notification_dedupe (
    idempotency_key TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX notification_dedupe_expiry ON notification_dedupe(expires_at);
  PRAGMA user_version = 1;
`;
