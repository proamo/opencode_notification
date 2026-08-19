import { Database } from "bun:sqlite";
import { chmod, copyFile, lstat, rename } from "node:fs/promises";
import { join } from "node:path";
import type { RouteKey } from "../protocol";

const CURRENT_SCHEMA_VERSION = 2;
const DATABASE_FILENAME = "state.sqlite";

export type MessageRouteKind =
  | "session_prompt"
  | "question_reply"
  | "permission_notice"
  | "informational";
export type MessageRouteStatus = "active" | "consumed" | "expired" | "offline";

export type MessageRouteRecord = {
  chatId: string;
  messageId: number;
  route: RouteKey;
  kind: MessageRouteKind;
  interactionId?: string;
  createdAt: number;
  expiresAt: number;
  status: MessageRouteStatus;
};

export type CallbackTokenRecord = {
  token: string;
  chatId: string;
  messageId: number;
  action: string;
  payload?: string;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
};

export type OutboxRecord = {
  id: number;
  idempotencyKey: string;
  chatId: string;
  payload: string;
  priority: number;
  attempts: number;
  nextAttemptAt: number;
  expiresAt: number;
  status: "pending" | "retry" | "delivered" | "failed";
  resultCode: string | null;
  createdAt: number;
  updatedAt: number;
};

export type RetentionPolicy = {
  terminalRouteRetentionMs: number;
  terminalOutboxRetentionMs: number;
  inboundUpdateRetentionMs: number;
  maxMessageRoutes: number;
  maxCallbackTokens: number;
  maxOutboxRecords: number;
  maxInboundUpdates: number;
  maxDedupeRecords: number;
};

export type CleanupResult = {
  expiredMessageRoutes: number;
  expiredOutboxRecords: number;
  deletedMessageRoutes: number;
  deletedCallbackTokens: number;
  deletedOutboxRecords: number;
  deletedInboundUpdates: number;
  deletedDedupeRecords: number;
};

export type StateInspection = {
  schemaVersion: number;
  machineId: string;
  telegramUpdateOffset: number;
  messageRoutes: Record<MessageRouteStatus, number>;
  callbackTokens: number;
  outbox: Record<OutboxRecord["status"], number>;
  inboundUpdates: number;
  dedupeRecords: number;
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  terminalRouteRetentionMs: 7 * 24 * 60 * 60_000,
  terminalOutboxRetentionMs: 7 * 24 * 60 * 60_000,
  inboundUpdateRetentionMs: 7 * 24 * 60 * 60_000,
  maxMessageRoutes: 10_000,
  maxCallbackTokens: 50_000,
  maxOutboxRecords: 10_000,
  maxInboundUpdates: 50_000,
  maxDedupeRecords: 50_000,
};

export class StateDatabase {
  readonly path: string;
  readonly #database: Database;
  #closed = false;

  private constructor(path: string, database: Database) {
    this.path = path;
    this.#database = database;
  }

  static async open(input: { stateDirectory: string; machineId: string }): Promise<StateDatabase> {
    const path = join(input.stateDirectory, DATABASE_FILENAME);
    const existed = await validateExistingDatabase(path);
    const database = new Database(path, { create: true, strict: true });

    try {
      await chmod(path, 0o600);
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA busy_timeout = 5000");
      const currentVersion = readSchemaVersion(database);
      if (currentVersion > CURRENT_SCHEMA_VERSION) {
        throw new DatabaseVersionError(currentVersion, CURRENT_SCHEMA_VERSION);
      }
      if (currentVersion < CURRENT_SCHEMA_VERSION) {
        if (existed && currentVersion > 0) await backupDatabase(database, path, currentVersion);
        migrate(database, currentVersion);
      }
      assertMachineIdentity(database, input.machineId);
      return new StateDatabase(path, database);
    } catch (error) {
      database.close(false);
      throw error;
    }
  }

  get schemaVersion(): number {
    this.#assertOpen();
    return readSchemaVersion(this.#database);
  }

  getTelegramUpdateOffset(): number {
    this.#assertOpen();
    const row = this.#database
      .query("SELECT value FROM meta WHERE key = 'telegram_update_offset'")
      .get() as { value: string } | null;
    return row ? Number(row.value) : 0;
  }

  getTelegramBotFingerprint(): string | undefined {
    this.#assertOpen();
    const row = this.#database
      .query("SELECT value FROM meta WHERE key = 'telegram_bot_id'")
      .get() as { value: string } | null;
    return row?.value;
  }

  pinTelegramBotFingerprint(botId: string): void {
    this.#assertOpen();
    this.#database.transaction(() => {
      const existing = this.getTelegramBotFingerprint();
      if (existing && existing !== botId) {
        throw new Error("configured Telegram bot does not match the pinned bot identity");
      }
      this.#database
        .query("INSERT OR IGNORE INTO meta (key, value) VALUES ('telegram_bot_id', ?)")
        .run(botId);
    })();
  }

  commitInboundUpdate(input: {
    updateId: number;
    actionId?: string;
    disposition: "rejected" | "acknowledged" | "failed";
    payloadHash?: string;
    occurredAt: number;
  }): boolean {
    this.#assertOpen();
    return this.#database.transaction(() => {
      const result = this.#database
        .query(
          `INSERT OR IGNORE INTO inbound_updates
           (update_id, action_id, disposition, payload_hash, occurred_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.updateId,
          input.actionId ?? null,
          input.disposition,
          input.payloadHash ?? null,
          input.occurredAt,
        );
      if (result.changes === 0) return false;

      const nextOffset = Math.max(this.getTelegramUpdateOffset(), input.updateId + 1);
      this.#database
        .query(
          `INSERT INTO meta (key, value) VALUES ('telegram_update_offset', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(String(nextOffset));
      return true;
    })();
  }

  saveMessageRoute(record: MessageRouteRecord): void {
    this.#assertOpen();
    this.#database
      .query(
        `INSERT INTO message_routes (
           chat_id, message_id, machine_id, instance_id, project_id, session_id,
           route_generation, kind, interaction_id, created_at, expires_at, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, message_id) DO UPDATE SET
           machine_id = excluded.machine_id,
           instance_id = excluded.instance_id,
           project_id = excluded.project_id,
           session_id = excluded.session_id,
           route_generation = excluded.route_generation,
           kind = excluded.kind,
           interaction_id = excluded.interaction_id,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           status = excluded.status`,
      )
      .run(
        record.chatId,
        record.messageId,
        record.route.machineId,
        record.route.instanceId,
        record.route.projectId,
        record.route.sessionId,
        record.route.routeGeneration,
        record.kind,
        record.interactionId ?? null,
        record.createdAt,
        record.expiresAt,
        record.status,
      );
  }

  getMessageRoute(chatId: string, messageId: number): MessageRouteRecord | undefined {
    this.#assertOpen();
    const row = this.#database
      .query("SELECT * FROM message_routes WHERE chat_id = ? AND message_id = ?")
      .get(chatId, messageId) as MessageRouteRow | null;
    return row ? messageRouteFromRow(row) : undefined;
  }

  setMessageRouteStatus(chatId: string, messageId: number, status: MessageRouteStatus): boolean {
    this.#assertOpen();
    return (
      this.#database
        .query("UPDATE message_routes SET status = ? WHERE chat_id = ? AND message_id = ?")
        .run(status, chatId, messageId).changes > 0
    );
  }

  saveCallbackToken(record: CallbackTokenRecord): void {
    this.#assertOpen();
    this.#insertCallbackToken(record);
  }

  getCallbackToken(token: string): CallbackTokenRecord | undefined {
    this.#assertOpen();
    const row = this.#database
      .query("SELECT * FROM callback_tokens WHERE token = ?")
      .get(token) as CallbackTokenRow | null;
    return row ? callbackTokenFromRow(row) : undefined;
  }

  enqueueOutbox(input: {
    idempotencyKey: string;
    chatId: string;
    payload: string;
    priority: number;
    nextAttemptAt: number;
    expiresAt: number;
    createdAt: number;
  }): { id: number; created: boolean } {
    this.#assertOpen();
    return this.#database.transaction(() => {
      const result = this.#database
        .query(
          `INSERT OR IGNORE INTO outbox
           (idempotency_key, chat_id, payload, priority, next_attempt_at, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.idempotencyKey,
          input.chatId,
          input.payload,
          input.priority,
          input.nextAttemptAt,
          input.expiresAt,
          input.createdAt,
          input.createdAt,
        );
      const row = this.#database
        .query("SELECT id FROM outbox WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as { id: number };
      return { id: row.id, created: result.changes > 0 };
    })();
  }

  nextOutbox(now: number, limit: number): OutboxRecord[] {
    this.#assertOpen();
    const rows = this.#database
      .query(
        `SELECT * FROM outbox
         WHERE status IN ('pending', 'retry') AND next_attempt_at <= ? AND expires_at > ?
         ORDER BY priority DESC, created_at ASC LIMIT ?`,
      )
      .all(now, now, limit) as OutboxRow[];
    return rows.map(outboxFromRow);
  }

  recordOutboxRetry(id: number, nextAttemptAt: number, resultCode: string, now: number): void {
    this.#assertOpen();
    this.#database
      .query(
        `UPDATE outbox SET status = 'retry', attempts = attempts + 1,
         next_attempt_at = ?, result_code = ?, updated_at = ? WHERE id = ?`,
      )
      .run(nextAttemptAt, resultCode, now, id);
  }

  finishOutbox(
    id: number,
    status: "delivered" | "failed",
    resultCode: string | null,
    now: number,
  ): void {
    this.#assertOpen();
    this.#database
      .query(
        `UPDATE outbox SET status = ?, attempts = attempts + 1,
         result_code = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, resultCode, now, id);
  }

  finishOutboxDeliveryWithBinding(input: {
    outboxId: number;
    route: MessageRouteRecord;
    callbackTokens?: CallbackTokenRecord[];
    now: number;
  }): void {
    this.#assertOpen();
    this.#database.transaction(() => {
      this.saveMessageRoute(input.route);
      for (const token of input.callbackTokens ?? []) this.#insertCallbackToken(token);
      this.finishOutbox(input.outboxId, "delivered", null, input.now);
    })();
  }

  claimNotification(idempotencyKey: string, expiresAt: number, now: number): boolean {
    this.#assertOpen();
    return this.#database.transaction(() => {
      this.#database.query("DELETE FROM notification_dedupe WHERE expires_at <= ?").run(now);
      return (
        this.#database
          .query(
            "INSERT OR IGNORE INTO notification_dedupe (idempotency_key, expires_at) VALUES (?, ?)",
          )
          .run(idempotencyKey, expiresAt).changes > 0
      );
    })();
  }

  cleanup(now: number, policy: RetentionPolicy = DEFAULT_RETENTION_POLICY): CleanupResult {
    this.#assertOpen();
    validateRetentionPolicy(policy);
    return this.#database.transaction(() => {
      const expiredMessageRoutes = this.#database
        .query(
          "UPDATE message_routes SET status = 'expired' WHERE status = 'active' AND expires_at <= ?",
        )
        .run(now).changes;
      const expiredOutboxRecords = this.#database
        .query(
          `UPDATE outbox SET status = 'failed', result_code = 'EXPIRED', updated_at = ?
           WHERE status IN ('pending', 'retry') AND expires_at <= ?`,
        )
        .run(now, now).changes;
      const deletedMessageRoutes =
        this.#database
          .query("DELETE FROM message_routes WHERE status != 'active' AND created_at <= ?")
          .run(now - policy.terminalRouteRetentionMs).changes +
        trimRows(this.#database, "message_routes", "created_at", policy.maxMessageRoutes);
      const deletedCallbackTokens =
        this.#database.query("DELETE FROM callback_tokens WHERE expires_at <= ?").run(now).changes +
        trimRows(this.#database, "callback_tokens", "created_at", policy.maxCallbackTokens);
      const deletedOutboxRecords =
        this.#database
          .query("DELETE FROM outbox WHERE status IN ('delivered', 'failed') AND updated_at <= ?")
          .run(now - policy.terminalOutboxRetentionMs).changes +
        trimRows(this.#database, "outbox", "created_at", policy.maxOutboxRecords);
      const deletedInboundUpdates =
        this.#database
          .query("DELETE FROM inbound_updates WHERE occurred_at <= ?")
          .run(now - policy.inboundUpdateRetentionMs).changes +
        trimRows(this.#database, "inbound_updates", "occurred_at", policy.maxInboundUpdates);
      const deletedDedupeRecords =
        this.#database.query("DELETE FROM notification_dedupe WHERE expires_at <= ?").run(now)
          .changes +
        trimRows(this.#database, "notification_dedupe", "expires_at", policy.maxDedupeRecords);

      return {
        expiredMessageRoutes,
        expiredOutboxRecords,
        deletedMessageRoutes,
        deletedCallbackTokens,
        deletedOutboxRecords,
        deletedInboundUpdates,
        deletedDedupeRecords,
      };
    })();
  }

  inspect(): StateInspection {
    this.#assertOpen();
    return {
      schemaVersion: this.schemaVersion,
      machineId: this.#metaValue("machine_id"),
      telegramUpdateOffset: this.getTelegramUpdateOffset(),
      messageRoutes: countStatuses<MessageRouteStatus>(this.#database, "message_routes", [
        "active",
        "consumed",
        "expired",
        "offline",
      ]),
      callbackTokens: countTable(this.#database, "callback_tokens"),
      outbox: countStatuses<OutboxRecord["status"]>(this.#database, "outbox", [
        "pending",
        "retry",
        "delivered",
        "failed",
      ]),
      inboundUpdates: countTable(this.#database, "inbound_updates"),
      dedupeRecords: countTable(this.#database, "notification_dedupe"),
    };
  }

  purgeOperationalState(): StateInspection {
    this.#assertOpen();
    const before = this.inspect();
    this.#database.transaction(() => {
      this.#database.exec("DELETE FROM message_routes");
      this.#database.exec("DELETE FROM callback_tokens");
      this.#database.exec("DELETE FROM outbox");
      this.#database.exec("DELETE FROM inbound_updates");
      this.#database.exec("DELETE FROM notification_dedupe");
      this.#database.exec("DELETE FROM meta WHERE key = 'telegram_update_offset'");
    })();
    return before;
  }

  vacuum(): void {
    this.#assertOpen();
    this.#database.exec("VACUUM");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.#database.close(false);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("state database is closed");
  }

  #insertCallbackToken(record: CallbackTokenRecord): void {
    this.#database
      .query(
        `INSERT OR REPLACE INTO callback_tokens (
           token, chat_id, message_id, action, payload, created_at, expires_at, consumed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.token,
        record.chatId,
        record.messageId,
        record.action,
        record.payload ?? null,
        record.createdAt,
        record.expiresAt,
        record.consumedAt ?? null,
      );
  }

  #metaValue(key: string): string {
    const row = this.#database.query("SELECT value FROM meta WHERE key = ?").get(key) as {
      value: string;
    } | null;
    if (!row) throw new Error(`required database metadata is missing: ${key}`);
    return row.value;
  }
}

export class DatabaseVersionError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`database schema version ${found} is newer than supported version ${supported}`);
    this.name = "DatabaseVersionError";
  }
}

export type DatabaseIntegrity =
  | { status: "missing" }
  | { status: "healthy" }
  | { status: "corrupt"; reason: string };

export async function inspectDatabaseIntegrity(stateDirectory: string): Promise<DatabaseIntegrity> {
  const path = join(stateDirectory, DATABASE_FILENAME);
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { status: "corrupt", reason: "database path is not a regular file" };
    }
  } catch (error) {
    if (isNotFoundError(error)) return { status: "missing" };
    return { status: "corrupt", reason: "database metadata cannot be read" };
  }

  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true, strict: true });
    const row = database.query("PRAGMA quick_check").get() as { quick_check: string };
    return row.quick_check === "ok"
      ? { status: "healthy" }
      : { status: "corrupt", reason: "SQLite quick_check failed" };
  } catch {
    return { status: "corrupt", reason: "SQLite database cannot be opened" };
  } finally {
    database?.close(false);
  }
}

export async function repairCorruptStateDatabase(input: {
  stateDirectory: string;
  machineId: string;
  confirm: boolean;
  force?: boolean;
}): Promise<{ archivePath: string; previousIntegrity: DatabaseIntegrity }> {
  if (!input.confirm) throw new Error("database repair requires explicit confirmation");
  const integrity = await inspectDatabaseIntegrity(input.stateDirectory);
  if (integrity.status === "missing") throw new Error("state database does not exist");
  if (integrity.status === "healthy" && !input.force) {
    throw new Error("state database is healthy; use force only for intentional reset");
  }

  const path = join(input.stateDirectory, DATABASE_FILENAME);
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const archivePath = `${path}.pre-repair.${timestamp}`;
  await rename(path, archivePath);
  await moveSidecarIfPresent(`${path}-wal`, `${archivePath}-wal`);
  await moveSidecarIfPresent(`${path}-shm`, `${archivePath}-shm`);

  try {
    const replacement = await StateDatabase.open({
      stateDirectory: input.stateDirectory,
      machineId: input.machineId,
    });
    replacement.close();
  } catch (error) {
    await rename(archivePath, path);
    await moveSidecarIfPresent(`${archivePath}-wal`, `${path}-wal`);
    await moveSidecarIfPresent(`${archivePath}-shm`, `${path}-shm`);
    throw error;
  }
  return { archivePath, previousIntegrity: integrity };
}

type MessageRouteRow = {
  chat_id: string;
  message_id: number;
  machine_id: string;
  instance_id: string;
  project_id: string;
  session_id: string;
  route_generation: string;
  kind: MessageRouteKind;
  interaction_id: string | null;
  created_at: number;
  expires_at: number;
  status: MessageRouteStatus;
};

type CallbackTokenRow = {
  token: string;
  chat_id: string;
  message_id: number;
  action: string;
  payload: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
};

type OutboxRow = {
  id: number;
  idempotency_key: string;
  chat_id: string;
  payload: string;
  priority: number;
  attempts: number;
  next_attempt_at: number;
  expires_at: number;
  status: OutboxRecord["status"];
  result_code: string | null;
  created_at: number;
  updated_at: number;
};

function migrate(database: Database, fromVersion: number): void {
  database.transaction(() => {
    let version = fromVersion;
    if (version === 0) {
      database.exec(SCHEMA_VERSION_1);
      version = 1;
    }
    if (version === 1) {
      database.exec(SCHEMA_VERSION_2);
      version = 2;
    }
    database.exec(`PRAGMA user_version = ${version}`);
  })();
}

function readSchemaVersion(database: Database): number {
  const row = database.query("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function assertMachineIdentity(database: Database, machineId: string): void {
  const existing = database.query("SELECT value FROM meta WHERE key = 'machine_id'").get() as {
    value: string;
  } | null;
  if (existing && existing.value !== machineId) {
    throw new Error("state database belongs to a different machine identity");
  }
  database.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('machine_id', ?)").run(machineId);
}

async function validateExistingDatabase(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`${path} must be a regular file`);
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error(`${path} permissions must not allow group or other access`);
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw new Error(`${path} must be owned by the current user`);
    }
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function backupDatabase(database: Database, path: string, version: number): Promise<void> {
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  await copyFile(path, `${path}.v${version}.${timestamp}.backup`);
}

function messageRouteFromRow(row: MessageRouteRow): MessageRouteRecord {
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    route: {
      machineId: row.machine_id,
      instanceId: row.instance_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      routeGeneration: row.route_generation,
    },
    kind: row.kind,
    ...(row.interaction_id ? { interactionId: row.interaction_id } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

function callbackTokenFromRow(row: CallbackTokenRow): CallbackTokenRecord {
  return {
    token: row.token,
    chatId: row.chat_id,
    messageId: row.message_id,
    action: row.action,
    ...(row.payload ? { payload: row.payload } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
  };
}

function outboxFromRow(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    chatId: row.chat_id,
    payload: row.payload,
    priority: row.priority,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    expiresAt: row.expires_at,
    status: row.status,
    resultCode: row.result_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type MaintainedTable =
  | "message_routes"
  | "callback_tokens"
  | "outbox"
  | "inbound_updates"
  | "notification_dedupe";
type MaintenanceOrder = "created_at" | "occurred_at" | "expires_at";

function trimRows(
  database: Database,
  table: MaintainedTable,
  orderBy: MaintenanceOrder,
  maximum: number,
): number {
  const count = countTable(database, table);
  const overflow = count - maximum;
  if (overflow <= 0) return 0;
  return database
    .query(
      `DELETE FROM ${table} WHERE rowid IN (
         SELECT rowid FROM ${table} ORDER BY ${orderBy} ASC, rowid ASC LIMIT ?
       )`,
    )
    .run(overflow).changes;
}

function countTable(database: Database, table: MaintainedTable): number {
  const row = database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function countStatuses<T extends string>(
  database: Database,
  table: "message_routes" | "outbox",
  statuses: readonly T[],
): Record<T, number> {
  const result = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<T, number>;
  const rows = database
    .query(`SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`)
    .all() as Array<{ status: T; count: number }>;
  for (const row of rows) result[row.status] = row.count;
  return result;
}

function validateRetentionPolicy(policy: RetentionPolicy): void {
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`retention policy ${key} must be a non-negative safe integer`);
    }
  }
}

async function moveSidecarIfPresent(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const SCHEMA_VERSION_1 = `
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
`;

const SCHEMA_VERSION_2 = `
  CREATE TABLE callback_tokens (
    token TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    payload TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    FOREIGN KEY (chat_id, message_id) REFERENCES message_routes(chat_id, message_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX callback_tokens_message ON callback_tokens(chat_id, message_id);
  CREATE INDEX callback_tokens_expiry ON callback_tokens(expires_at);
`;
