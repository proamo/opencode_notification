import { describe, expect, test } from "bun:test";
import {
  createAuthorizedUpdateHandler,
  TelegramUpdateAuthorizer,
  TelegramUpdateSchema,
} from "../src/telegram";

const USER_ID = 123456789;

describe("TelegramUpdateAuthorizer", () => {
  const authorizer = new TelegramUpdateAuthorizer({
    userId: String(USER_ID),
    chatId: String(USER_ID),
  });

  test("accepts only the pinned user in the pinned private chat", () => {
    expect(authorizer.authorize(parseUpdate(messageUpdate()))).toEqual({
      authorized: true,
      subject: {
        kind: "message",
        userId: String(USER_ID),
        chatId: String(USER_ID),
      },
    });
  });

  test.each([
    ["wrong user", messageUpdate({ from: user(999) }), "USER_MISMATCH"],
    ["bot sender", messageUpdate({ from: user(USER_ID, true) }), "BOT_SENDER"],
    ["missing user", messageUpdate({ from: undefined }), "USER_MISSING"],
    ["group chat", messageUpdate({ chat: chat(-100, "group") }), "CHAT_NOT_PRIVATE"],
    ["wrong private chat", messageUpdate({ chat: chat(999, "private") }), "CHAT_MISMATCH"],
    [
      "forwarded message",
      messageUpdate({ forward_origin: { type: "user", sender_user: user(USER_ID) } }),
      "FORWARDED_MESSAGE",
    ],
    ["anonymous sender", messageUpdate({ sender_chat: chat(-100, "group") }), "SENDER_CHAT"],
    [
      "business message",
      messageUpdate({ business_connection_id: "business_1" }),
      "BUSINESS_MESSAGE",
    ],
    ["unsupported update", { update_id: 1 }, "UNSUPPORTED_UPDATE"],
  ] as const)("rejects %s", (_label, input, reason) => {
    expect(authorizer.authorize(parseUpdate(input))).toEqual({ authorized: false, reason });
  });

  test("accepts an authorized callback only when its private chat message is present", () => {
    expect(authorizer.authorize(parseUpdate(callbackUpdate()))).toEqual({
      authorized: true,
      subject: {
        kind: "callback_query",
        userId: String(USER_ID),
        chatId: String(USER_ID),
      },
    });

    expect(
      authorizer.authorize(
        parseUpdate({
          ...callbackUpdate(),
          callback_query: { id: "callback_1", from: user(USER_ID), data: "opaque" },
        }),
      ),
    ).toEqual({ authorized: false, reason: "CHAT_MISSING" });
  });

  test("requires positive matching private user and chat IDs", () => {
    expect(() => new TelegramUpdateAuthorizer({ userId: "123", chatId: "456" })).toThrow(
      "private Telegram chat",
    );
    expect(() => new TelegramUpdateAuthorizer({ userId: "-123", chatId: "-123" })).toThrow(
      "positive numeric IDs",
    );
  });

  test("turns rejection into a terminal content-free disposition", async () => {
    let authorizedCalls = 0;
    const handler = createAuthorizedUpdateHandler(authorizer, () => {
      authorizedCalls += 1;
      return { disposition: "acknowledged" };
    });
    const update = parseUpdate(messageUpdate({ from: user(999), text: "sensitive command" }));

    const result = await handler(update);

    expect(result).toMatchObject({ disposition: "rejected", actionId: "USER_MISMATCH" });
    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("sensitive command");
    expect(authorizedCalls).toBe(0);
  });
});

function parseUpdate(input: unknown) {
  return TelegramUpdateSchema.parse(input);
}

function messageUpdate(
  overrides: Partial<{
    from: ReturnType<typeof user> | undefined;
    chat: ReturnType<typeof chat>;
    text: string;
    forward_origin: unknown;
    sender_chat: ReturnType<typeof chat>;
    business_connection_id: string;
  }> = {},
) {
  const from = Object.hasOwn(overrides, "from") ? overrides.from : user(USER_ID);
  return {
    update_id: 1,
    message: {
      message_id: 10,
      ...(from ? { from } : {}),
      chat: overrides.chat ?? chat(USER_ID, "private"),
      date: 1_700_000_000,
      text: overrides.text ?? "hello",
      ...(overrides.forward_origin ? { forward_origin: overrides.forward_origin } : {}),
      ...(overrides.sender_chat ? { sender_chat: overrides.sender_chat } : {}),
      ...(overrides.business_connection_id
        ? { business_connection_id: overrides.business_connection_id }
        : {}),
    },
  };
}

function callbackUpdate() {
  return {
    update_id: 2,
    callback_query: {
      id: "callback_1",
      from: user(USER_ID),
      message: {
        message_id: 11,
        chat: chat(USER_ID, "private"),
        date: 1_700_000_000,
        text: "Choose",
      },
      data: "opaque-token",
    },
  };
}

function user(id: number, isBot = false) {
  return { id, is_bot: isBot, first_name: "User" };
}

function chat(id: number, type: "private" | "group") {
  return { id, type };
}
