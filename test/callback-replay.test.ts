import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../src/state";
import { validateTelegramInteraction } from "../src/telegram/interaction";

describe("Callback Token Anti-Replay & Atomic Consumption", () => {
  let stateDirectory: string;
  let database: StateDatabase;
  const machineId = randomUUID();
  const chatId = "12345678";
  const messageId = 999;

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "opencode-replay-test-"));
    database = await StateDatabase.open({ stateDirectory, machineId });
  });

  afterAll(async () => {
    database.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });

  test("atomic consumption prevents double-execution and marks route consumed", () => {
    const token = "token_permission_once_abc123";
    const now = Date.now();

    database.saveMessageRoute({
      chatId,
      messageId,
      route: {
        machineId,
        instanceId: "inst-test",
        projectId: "/test/project",
        sessionId: "ses-1",
        routeGeneration: "gen-1",
      },
      kind: "permission_notice",
      interactionId: "perm-req-1",
      createdAt: now,
      expiresAt: now + 3600_000,
      status: "active",
    });

    database.saveCallbackToken({
      token,
      chatId,
      messageId,
      action: "permission.reply",
      payload: "once",
      createdAt: now,
      expiresAt: now + 3600_000,
    });

    // 1st consumption attempt succeeds
    const firstAttempt = database.consumeCallbackTokenAndRoute({
      token,
      chatId,
      messageId,
      now,
    });
    expect(firstAttempt).toBe(true);

    // 2nd consumption attempt (replay) fails atomically
    const secondAttempt = database.consumeCallbackTokenAndRoute({
      token,
      chatId,
      messageId,
      now,
    });
    expect(secondAttempt).toBe(false);

    // Verify interaction validator returns ALREADY_HANDLED
    const fakeUpdate = {
      update_id: 101,
      callback_query: {
        id: "cb-1",
        from: { id: 12345678, is_bot: false, first_name: "User" },
        chat_instance: "inst-1",
        data: token,
        message: {
          message_id: messageId,
          date: Math.floor(now / 1000),
          chat: { id: 12345678, type: "private" as const },
        },
      },
    };

    const validation = validateTelegramInteraction(
      fakeUpdate,
      { kind: "callback_query", chatId, userId: "12345678" },
      {
        database,
        isRouteLive: () => true,
        now: () => now,
      },
    );

    expect(validation.accepted).toBe(false);
    if (!validation.accepted) {
      expect(validation.reason).toBe("ALREADY_HANDLED");
    }
  });
});
