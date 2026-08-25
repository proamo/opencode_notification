import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrokerCommand, RouteKey } from "../src/protocol";
import { StateDatabase } from "../src/state";
import {
  createValidatedInteractionHandler,
  interactionFeedbackText,
  submitCompletedSessionReply,
  submitQuestionReply,
  submitTelegramInteraction,
  TelegramUpdateAuthorizer,
  TelegramUpdateSchema,
  validateTelegramInteraction,
  validationFeedback,
} from "../src/telegram";

const USER_ID = 123456789;
const temporaryDirectories: string[] = [];
const databases: StateDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("validateTelegramInteraction", () => {
  test("accepts a direct reply only through the exact active message binding and live route", async () => {
    const database = await createDatabase();
    const route = routeKey();
    saveRoute(database, route, "session_prompt");

    const result = validateTelegramInteraction(parseUpdate(messageReply()), subject("message"), {
      database,
      isRouteLive: (candidate) => candidate.routeGeneration === route.routeGeneration,
      now: () => 2_000,
    });

    expect(result).toEqual({
      accepted: true,
      interaction: {
        updateId: 1,
        chatId: String(USER_ID),
        messageId: 77,
        kind: "session_prompt",
        route,
        text: "Continue safely",
      },
    });
  });

  test.each([
    [
      "unthreaded message",
      messageReply({ replyToMessageId: undefined }),
      "MESSAGE_BINDING_REQUIRED",
    ],
    ["unknown binding", messageReply({ replyToMessageId: 999 }), "MESSAGE_BINDING_NOT_FOUND"],
  ] as const)("rejects %s", async (_label, update, reason) => {
    const database = await createDatabase();
    saveRoute(database, routeKey(), "session_prompt");

    const result = validateTelegramInteraction(parseUpdate(update), subject("message"), {
      database,
      isRouteLive: () => true,
      now: () => 2_000,
    });

    expect(result).toMatchObject({ accepted: false, reason });
    expect(result.accepted ? undefined : result.disposition.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects expired, inactive, stale, and already-handled replies fail-closed", async () => {
    const database = await createDatabase();
    const route = routeKey();
    saveRoute(database, route, "session_prompt", { expiresAt: 1_500 });
    expect(
      validateTelegramInteraction(parseUpdate(messageReply()), subject("message"), {
        database,
        isRouteLive: () => true,
        now: () => 2_000,
      }),
    ).toMatchObject({ accepted: false, reason: "MESSAGE_BINDING_EXPIRED" });
    expect(database.getMessageRoute(String(USER_ID), 77)?.status).toBe("expired");

    saveRoute(database, route, "session_prompt", { status: "consumed", messageId: 78 });
    expect(
      validateTelegramInteraction(
        parseUpdate(messageReply({ replyToMessageId: 78 })),
        subject("message"),
        { database, isRouteLive: () => true, now: () => 2_000 },
      ),
    ).toMatchObject({ accepted: false, reason: "MESSAGE_BINDING_INACTIVE" });

    saveRoute(database, route, "session_prompt", { messageId: 79 });
    expect(
      validateTelegramInteraction(
        parseUpdate(messageReply({ replyToMessageId: 79 })),
        subject("message"),
        { database, isRouteLive: () => false, now: () => 2_000 },
      ),
    ).toMatchObject({ accepted: false, reason: "ROUTE_STALE" });
    expect(database.getMessageRoute(String(USER_ID), 79)?.status).toBe("offline");

    database.commitInboundUpdate({ updateId: 4, disposition: "acknowledged", occurredAt: 2_000 });
    expect(
      validateTelegramInteraction(
        parseUpdate(messageReply({ updateId: 4, replyToMessageId: 79 })),
        subject("message"),
        { database, isRouteLive: () => true, now: () => 2_000 },
      ),
    ).toMatchObject({ accepted: false, reason: "ALREADY_HANDLED" });
  });

  test("accepts callback tokens only for their exact bound question message", async () => {
    const database = await createDatabase();
    const route = routeKey();
    saveRoute(database, route, "question_reply", { interactionId: "question_1" });
    database.saveCallbackToken({
      token: "opaque-token",
      chatId: String(USER_ID),
      messageId: 77,
      action: "question.option",
      payload: "0:1",
      createdAt: 1_000,
      expiresAt: 10_000,
    });

    const result = validateTelegramInteraction(
      parseUpdate(callbackUpdate()),
      subject("callback_query"),
      {
        database,
        isRouteLive: () => true,
        now: () => 2_000,
      },
    );

    expect(result).toEqual({
      accepted: true,
      interaction: {
        updateId: 2,
        chatId: String(USER_ID),
        messageId: 77,
        kind: "question_reply",
        route,
        interactionId: "question_1",
        callbackToken: "opaque-token",
        callbackAction: "question.option",
        callbackPayload: "0:1",
      },
    });
  });

  test.each([
    ["missing token", callbackUpdate({ token: undefined }), "CALLBACK_TOKEN_INVALID"],
    ["unknown token", callbackUpdate({ token: "unknown" }), "CALLBACK_TOKEN_INVALID"],
    ["wrong message", callbackUpdate({ messageId: 78 }), "CALLBACK_TOKEN_MESSAGE_MISMATCH"],
  ] as const)("rejects callback with %s", async (_label, update, reason) => {
    const database = await createDatabase();
    saveRoute(database, routeKey(), "question_reply");
    database.saveCallbackToken({
      token: "opaque-token",
      chatId: String(USER_ID),
      messageId: 77,
      action: "question.option",
      createdAt: 1_000,
      expiresAt: 10_000,
    });

    expect(
      validateTelegramInteraction(parseUpdate(update), subject("callback_query"), {
        database,
        isRouteLive: () => true,
        now: () => 2_000,
      }),
    ).toMatchObject({ accepted: false, reason });
  });

  test("rejects expired callbacks and callbacks bound to non-question action kinds", async () => {
    const database = await createDatabase();
    saveRoute(database, routeKey(), "question_reply");
    database.saveCallbackToken({
      token: "opaque-token",
      chatId: String(USER_ID),
      messageId: 77,
      action: "question.option",
      createdAt: 1_000,
      expiresAt: 1_500,
    });
    expect(
      validateTelegramInteraction(parseUpdate(callbackUpdate()), subject("callback_query"), {
        database,
        isRouteLive: () => true,
        now: () => 2_000,
      }),
    ).toMatchObject({ accepted: false, reason: "CALLBACK_TOKEN_EXPIRED" });

    saveRoute(database, routeKey(), "informational", { messageId: 78 });
    database.saveCallbackToken({
      token: "permission-token",
      chatId: String(USER_ID),
      messageId: 78,
      action: "permission.noop",
      createdAt: 1_000,
      expiresAt: 10_000,
    });
    expect(
      validateTelegramInteraction(
        parseUpdate(callbackUpdate({ messageId: 78, token: "permission-token" })),
        subject("callback_query"),
        { database, isRouteLive: () => true, now: () => 2_000 },
      ),
    ).toMatchObject({ accepted: false, reason: "ACTION_KIND_MISMATCH" });
  });

  test("submits permission callback buttons as permission reply commands", async () => {
    const database = await createDatabase();
    const route = routeKey();
    saveRoute(database, route, "permission_notice", { interactionId: "perm_1", messageId: 88 });
    database.saveCallbackToken({
      token: "perm-token-allow",
      chatId: String(USER_ID),
      messageId: 88,
      action: "permission.reply",
      payload: "once",
      createdAt: 1_000,
      expiresAt: 10_000,
    });

    const validation = validateTelegramInteraction(
      parseUpdate(callbackUpdate({ messageId: 88, token: "perm-token-allow" })),
      subject("callback_query"),
      {
        database,
        isRouteLive: () => true,
        now: () => 2_000,
      },
    );
    if (!validation.accepted) throw new Error("expected accepted permission interaction");
    let command: BrokerCommand | undefined;

    const outcome = await submitTelegramInteraction(
      {
        sendCommand: async (input) => {
          command = input;
          return { commandId: input.commandId, status: "accepted" };
        },
      },
      validation.interaction,
    );

    expect(outcome.feedback).toBe("accepted");
    expect(command).toMatchObject({
      type: "permission.reply",
      route,
      interactionId: "perm_1",
      response: "once",
    });
  });

  test("combines identity authorization with binding validation", async () => {
    const database = await createDatabase();
    const route = routeKey();
    saveRoute(database, route, "session_prompt");
    const authorizer = new TelegramUpdateAuthorizer({
      userId: String(USER_ID),
      chatId: String(USER_ID),
    });
    let validated = 0;
    const handler = createValidatedInteractionHandler(
      authorizer,
      { database, isRouteLive: () => true, now: () => 2_000 },
      (interaction) => {
        validated += 1;
        expect(interaction.route).toEqual(route);
        return { disposition: "acknowledged", actionId: "accepted" };
      },
    );

    expect(await handler(parseUpdate(messageReply()))).toEqual({
      disposition: "acknowledged",
      actionId: "accepted",
    });
    expect(await handler(parseUpdate(messageReply({ from: user(999) })))).toMatchObject({
      disposition: "rejected",
      actionId: "USER_MISMATCH",
    });
    expect(validated).toBe(1);
  });

  test("submits completed-session replies as session prompt commands", async () => {
    const database = await createDatabase();
    const route = routeKey();
    saveRoute(database, route, "session_prompt");
    const validation = validateTelegramInteraction(
      parseUpdate(messageReply()),
      subject("message"),
      {
        database,
        isRouteLive: () => true,
        now: () => 2_000,
      },
    );
    if (!validation.accepted) throw new Error("expected accepted interaction");
    let command: BrokerCommand | undefined;

    const result = await submitCompletedSessionReply(
      {
        sendCommand: async (input) => {
          command = input;
          return { commandId: input.commandId, status: "accepted" };
        },
      },
      validation.interaction,
    );

    expect(result.status).toBe("accepted");
    expect(command).toMatchObject({ type: "session.prompt", route, text: "Continue safely" });
    expect(command?.commandId).toBe(result.commandId);
  });

  test("does not submit non-session or empty replies", async () => {
    const route = routeKey();
    let dispatched = false;
    const dispatcher = {
      sendCommand: async (input: BrokerCommand) => {
        dispatched = true;
        return { commandId: input.commandId, status: "accepted" as const };
      },
    };

    await expect(
      submitCompletedSessionReply(dispatcher, {
        updateId: 1,
        chatId: String(USER_ID),
        messageId: 77,
        kind: "question_reply",
        route,
        text: "Continue safely",
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "not a session prompt binding" });
    await expect(
      submitCompletedSessionReply(dispatcher, {
        updateId: 2,
        chatId: String(USER_ID),
        messageId: 78,
        kind: "session_prompt",
        route,
        text: "   ",
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "empty prompt" });
    expect(dispatched).toBe(false);
  });

  test("submits question callbacks as constrained question reply commands", async () => {
    const database = await createDatabase();
    const route = routeKey();
    saveRoute(database, route, "question_reply", { interactionId: "question_1" });
    database.saveCallbackToken({
      token: "opaque-token",
      chatId: String(USER_ID),
      messageId: 77,
      action: "question.option",
      payload: JSON.stringify({ answers: [["Option A", "Option B"]] }),
      createdAt: 1_000,
      expiresAt: 10_000,
    });
    const validation = validateTelegramInteraction(
      parseUpdate(callbackUpdate()),
      subject("callback_query"),
      {
        database,
        isRouteLive: () => true,
        now: () => 2_000,
      },
    );
    if (!validation.accepted) throw new Error("expected accepted interaction");
    let command: BrokerCommand | undefined;

    const result = await submitQuestionReply(
      {
        sendCommand: async (input) => {
          command = input;
          return { commandId: input.commandId, status: "accepted" };
        },
      },
      validation.interaction,
    );

    expect(result.status).toBe("accepted");
    expect(command).toMatchObject({
      type: "question.reply",
      route,
      interactionId: "question_1",
      answers: [["Option A", "Option B"]],
    });
  });

  test("submits free-text question replies and rejects invalid question answers", async () => {
    const route = routeKey();
    let dispatched = false;
    const dispatcher = {
      sendCommand: async (input: BrokerCommand) => {
        dispatched = true;
        return { commandId: input.commandId, status: "accepted" as const };
      },
    };

    await expect(
      submitQuestionReply(dispatcher, {
        updateId: 3,
        chatId: String(USER_ID),
        messageId: 78,
        kind: "question_reply",
        route,
        interactionId: "question_1",
        text: "  custom answer  ",
      }),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(dispatched).toBe(true);

    dispatched = false;
    await expect(
      submitQuestionReply(dispatcher, {
        updateId: 4,
        chatId: String(USER_ID),
        messageId: 79,
        kind: "question_reply",
        route,
        interactionId: "question_1",
        callbackAction: "question.option",
        callbackPayload: "0:0",
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "invalid question answer" });
    expect(dispatched).toBe(false);
  });

  test("keeps permission replies terminal-only with localized feedback", async () => {
    const database = await createDatabase();
    const route = routeKey();
    saveRoute(database, route, "permission_notice");
    const validation = validateTelegramInteraction(
      parseUpdate(messageReply()),
      subject("message"),
      {
        database,
        isRouteLive: () => true,
        now: () => 2_000,
      },
    );
    if (!validation.accepted) throw new Error("expected accepted interaction");
    let dispatched = false;

    const outcome = await submitTelegramInteraction(
      {
        sendCommand: async (input) => {
          dispatched = true;
          return { commandId: input.commandId, status: "accepted" };
        },
      },
      validation.interaction,
    );

    expect(outcome).toMatchObject({
      result: { status: "rejected", reason: "terminal intervention required" },
      feedback: "terminal_only",
    });
    expect(dispatched).toBe(false);
    expect(interactionFeedbackText("en", outcome.feedback)).toBe(
      "This action must be handled in the OpenCode terminal.",
    );
    expect(interactionFeedbackText("zh-TW", outcome.feedback)).toBe(
      "此操作必須在 OpenCode 終端機中處理。",
    );
  });

  test("maps rejected validation reasons to localized guidance categories", async () => {
    expect(validationFeedback("MESSAGE_BINDING_REQUIRED")).toBe("reply_required");
    expect(validationFeedback("MESSAGE_BINDING_NOT_FOUND")).toBe("rejected");
    expect(validationFeedback("MESSAGE_BINDING_EXPIRED")).toBe("expired");
    expect(validationFeedback("MESSAGE_BINDING_INACTIVE")).toBe("stale");
    expect(validationFeedback("ALREADY_HANDLED")).toBe("already_handled");
    expect(validationFeedback("ROUTE_STALE")).toBe("offline");
    expect(validationFeedback("ACTION_KIND_MISMATCH")).toBe("invalid");
    expect(interactionFeedbackText("en", validationFeedback("MESSAGE_BINDING_REQUIRED"))).toBe(
      "Reply directly to an actionable notification.",
    );
    expect(interactionFeedbackText("en", validationFeedback("ALREADY_HANDLED"))).toBe(
      "This response was already handled.",
    );
  });

  test.each([
    [{ status: "accepted" as const }, "accepted"],
    [{ status: "rejected" as const, reason: "session prompt failed" }, "rejected"],
    [{ status: "rejected" as const, reason: "invalid question answer" }, "invalid"],
    [{ status: "stale" as const, reason: "route is offline" }, "offline"],
    [{ status: "stale" as const, reason: "question already resolved" }, "stale"],
    [{ status: "indeterminate" as const, reason: "command timed out" }, "indeterminate"],
  ])("maps command result %o to %s feedback", async (result, feedback) => {
    const route = routeKey();
    const commandId = crypto.randomUUID();

    await expect(
      submitTelegramInteraction(
        {
          sendCommand: async () => ({ commandId, ...result }),
        },
        {
          updateId: 5,
          chatId: String(USER_ID),
          messageId: 80,
          kind: "session_prompt",
          route,
          text: "Continue safely",
        },
      ),
    ).resolves.toMatchObject({ feedback });
  });
});

async function createDatabase(): Promise<StateDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-telegram-interaction-"));
  temporaryDirectories.push(directory);
  const database = await StateDatabase.open({
    stateDirectory: directory,
    machineId: crypto.randomUUID(),
  });
  databases.push(database);
  return database;
}

function saveRoute(
  database: StateDatabase,
  route: RouteKey,
  kind: "session_prompt" | "question_reply" | "permission_notice" | "informational",
  options: Partial<{
    messageId: number;
    interactionId: string;
    expiresAt: number;
    status: "active" | "consumed" | "expired" | "offline";
  }> = {},
): void {
  database.saveMessageRoute({
    chatId: String(USER_ID),
    messageId: options.messageId ?? 77,
    route,
    kind,
    ...(options.interactionId ? { interactionId: options.interactionId } : {}),
    createdAt: 1_000,
    expiresAt: options.expiresAt ?? 10_000,
    status: options.status ?? "active",
  });
}

function routeKey(): RouteKey {
  return {
    machineId: crypto.randomUUID(),
    instanceId: crypto.randomUUID(),
    projectId: "opaque-project-id",
    sessionId: "ses_123",
    routeGeneration: crypto.randomUUID(),
  };
}

function parseUpdate(input: unknown) {
  return TelegramUpdateSchema.parse(input);
}

function subject(kind: "message" | "callback_query") {
  return { kind, userId: String(USER_ID), chatId: String(USER_ID) };
}

function messageReply(
  options: Partial<{
    updateId: number;
    replyToMessageId: number | undefined;
    from: ReturnType<typeof user>;
  }> = {},
) {
  const replyToMessageId = Object.hasOwn(options, "replyToMessageId")
    ? options.replyToMessageId
    : 77;
  return {
    update_id: options.updateId ?? 1,
    message: {
      message_id: 10,
      from: options.from ?? user(USER_ID),
      chat: chat(USER_ID),
      date: 1_700_000_000,
      text: "Continue safely",
      ...(replyToMessageId
        ? { reply_to_message: { message_id: replyToMessageId, chat: chat(USER_ID) } }
        : {}),
    },
  };
}

function callbackUpdate(
  options: Partial<{ updateId: number; messageId: number; token: string | undefined }> = {},
) {
  const token = Object.hasOwn(options, "token") ? options.token : "opaque-token";
  return {
    update_id: options.updateId ?? 2,
    callback_query: {
      id: "callback_1",
      from: user(USER_ID),
      message: {
        message_id: options.messageId ?? 77,
        chat: chat(USER_ID),
        date: 1_700_000_000,
        text: "Choose",
      },
      ...(token ? { data: token } : {}),
    },
  };
}

function user(id: number, isBot = false) {
  return { id, is_bot: isBot, first_name: "User" };
}

function chat(id: number) {
  return { id, type: "private" as const };
}
