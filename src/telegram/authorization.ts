import { createHash } from "node:crypto";
import type { TelegramUpdate } from "./api";
import type { UpdateDisposition } from "./poller";

export type AuthorizationRejection =
  | "UNSUPPORTED_UPDATE"
  | "USER_MISSING"
  | "BOT_SENDER"
  | "USER_MISMATCH"
  | "CHAT_MISSING"
  | "CHAT_NOT_PRIVATE"
  | "CHAT_MISMATCH"
  | "FORWARDED_MESSAGE"
  | "SENDER_CHAT"
  | "BUSINESS_MESSAGE";

export type AuthorizedUpdate = {
  kind: "message" | "callback_query";
  userId: string;
  chatId: string;
};

export type AuthorizationResult =
  | { authorized: true; subject: AuthorizedUpdate }
  | { authorized: false; reason: AuthorizationRejection };

export class TelegramUpdateAuthorizer {
  readonly #userId: string;
  readonly #chatId: string;

  constructor(input: { userId: string; chatId: string }) {
    if (!/^[1-9]\d*$/.test(input.userId) || !/^[1-9]\d*$/.test(input.chatId)) {
      throw new Error("Telegram authorization requires positive numeric IDs");
    }
    if (input.userId !== input.chatId) {
      throw new Error("V1 requires the allowed user's private Telegram chat");
    }
    this.#userId = input.userId;
    this.#chatId = input.chatId;
  }

  authorize(update: TelegramUpdate): AuthorizationResult {
    if (update.message) {
      if (update.message.business_connection_id) return rejected("BUSINESS_MESSAGE");
      if (update.message.forward_origin || update.message.author_signature) {
        return rejected("FORWARDED_MESSAGE");
      }
      if (update.message.sender_chat) return rejected("SENDER_CHAT");
      if (!update.message.from) return rejected("USER_MISSING");
      if (update.message.from.is_bot) return rejected("BOT_SENDER");
      if (String(update.message.from.id) !== this.#userId) return rejected("USER_MISMATCH");
      if (update.message.chat.type !== "private") return rejected("CHAT_NOT_PRIVATE");
      if (String(update.message.chat.id) !== this.#chatId) return rejected("CHAT_MISMATCH");
      return {
        authorized: true,
        subject: { kind: "message", userId: this.#userId, chatId: this.#chatId },
      };
    }

    const callback = update.callback_query;
    if (!callback) return rejected("UNSUPPORTED_UPDATE");
    if (callback.from.is_bot) return rejected("BOT_SENDER");
    if (String(callback.from.id) !== this.#userId) return rejected("USER_MISMATCH");
    if (!callback.message) return rejected("CHAT_MISSING");
    if (callback.message.business_connection_id) return rejected("BUSINESS_MESSAGE");
    if (callback.message.forward_origin || callback.message.author_signature) {
      return rejected("FORWARDED_MESSAGE");
    }
    if (callback.message.sender_chat) return rejected("SENDER_CHAT");
    if (callback.message.chat.type !== "private") return rejected("CHAT_NOT_PRIVATE");
    if (String(callback.message.chat.id) !== this.#chatId) return rejected("CHAT_MISMATCH");
    return {
      authorized: true,
      subject: { kind: "callback_query", userId: this.#userId, chatId: this.#chatId },
    };
  }
}

export function createAuthorizedUpdateHandler(
  authorizer: TelegramUpdateAuthorizer,
  handleAuthorized: (
    update: TelegramUpdate,
    subject: AuthorizedUpdate,
  ) => UpdateDisposition | Promise<UpdateDisposition>,
): (update: TelegramUpdate) => UpdateDisposition | Promise<UpdateDisposition> {
  return (update) => {
    const result = authorizer.authorize(update);
    if (result.authorized) return handleAuthorized(update, result.subject);
    return {
      disposition: "rejected",
      actionId: result.reason,
      payloadHash: rejectionHash(update.update_id, result.reason),
    };
  };
}

function rejected(reason: AuthorizationRejection): AuthorizationResult {
  return { authorized: false, reason };
}

function rejectionHash(updateId: number, reason: AuthorizationRejection): string {
  return createHash("sha256").update(`${updateId}:${reason}`).digest("hex");
}
