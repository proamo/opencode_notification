import { createHash, randomUUID } from "node:crypto";
import type { BrokerCommand, CommandResult, RouteKey } from "../protocol";
import type { MessageRouteKind, MessageRouteRecord, StateDatabase } from "../state";
import type { TelegramUpdate } from "./api";
import type { AuthorizedUpdate, TelegramUpdateAuthorizer } from "./authorization";
import { createAuthorizedUpdateHandler } from "./authorization";
import type { UpdateDisposition } from "./poller";

export type InteractionValidationReason =
  | "ALREADY_HANDLED"
  | "MESSAGE_BINDING_REQUIRED"
  | "MESSAGE_BINDING_NOT_FOUND"
  | "MESSAGE_BINDING_EXPIRED"
  | "MESSAGE_BINDING_INACTIVE"
  | "CALLBACK_TOKEN_INVALID"
  | "CALLBACK_TOKEN_EXPIRED"
  | "CALLBACK_TOKEN_MESSAGE_MISMATCH"
  | "ACTION_KIND_MISMATCH"
  | "ROUTE_STALE";

export type ValidatedTelegramInteraction = {
  updateId: number;
  chatId: string;
  messageId: number;
  kind: MessageRouteKind;
  route: RouteKey;
  interactionId?: string;
  text?: string;
  callbackToken?: string;
  callbackAction?: string;
  callbackPayload?: string;
};

export type InteractionValidationResult =
  | { accepted: true; interaction: ValidatedTelegramInteraction }
  | { accepted: false; reason: InteractionValidationReason; disposition: UpdateDisposition };

export type InteractionValidatorOptions = {
  database: StateDatabase;
  isRouteLive: (route: RouteKey) => boolean;
  now?: () => number;
};

export type BrokerCommandDispatcher = {
  sendCommand(command: BrokerCommand): Promise<CommandResult>;
};

export function validateTelegramInteraction(
  update: TelegramUpdate,
  subject: AuthorizedUpdate,
  options: InteractionValidatorOptions,
): InteractionValidationResult {
  const now = options.now?.() ?? Date.now();
  if (options.database.getInboundUpdate(update.update_id))
    return rejected(update, "ALREADY_HANDLED");

  const binding =
    subject.kind === "message"
      ? messageBinding(update, subject, options.database)
      : callbackBinding(update, subject, options.database, now);
  if (!binding.accepted) return rejected(update, binding.reason);

  const route = binding.route;
  const staleReason = validateRouteState(options.database, route, now, options.isRouteLive);
  if (staleReason) return rejected(update, staleReason);

  if (subject.kind === "callback_query" && route.kind !== "question_reply") {
    return rejected(update, "ACTION_KIND_MISMATCH");
  }

  return {
    accepted: true,
    interaction: {
      updateId: update.update_id,
      chatId: route.chatId,
      messageId: route.messageId,
      kind: route.kind,
      route: route.route,
      ...(route.interactionId ? { interactionId: route.interactionId } : {}),
      ...(binding.text ? { text: binding.text } : {}),
      ...(binding.callbackToken ? { callbackToken: binding.callbackToken } : {}),
      ...(binding.callbackAction ? { callbackAction: binding.callbackAction } : {}),
      ...(binding.callbackPayload ? { callbackPayload: binding.callbackPayload } : {}),
    },
  };
}

export function createValidatedInteractionHandler(
  authorizer: TelegramUpdateAuthorizer,
  options: InteractionValidatorOptions,
  handleValidated: (
    interaction: ValidatedTelegramInteraction,
    update: TelegramUpdate,
  ) => UpdateDisposition | Promise<UpdateDisposition>,
): (update: TelegramUpdate) => UpdateDisposition | Promise<UpdateDisposition> {
  return createAuthorizedUpdateHandler(authorizer, (update, subject) => {
    const result = validateTelegramInteraction(update, subject, options);
    if (!result.accepted) return result.disposition;
    return handleValidated(result.interaction, update);
  });
}

export async function submitCompletedSessionReply(
  dispatcher: BrokerCommandDispatcher,
  interaction: ValidatedTelegramInteraction,
): Promise<CommandResult> {
  if (interaction.kind !== "session_prompt") {
    return { commandId: randomUUID(), status: "rejected", reason: "not a session prompt binding" };
  }
  const text = interaction.text?.trim();
  if (!text) return { commandId: randomUUID(), status: "rejected", reason: "empty prompt" };
  return await dispatcher.sendCommand({
    type: "session.prompt",
    commandId: randomUUID(),
    route: interaction.route,
    text,
  });
}

type BindingResult =
  | {
      accepted: true;
      route: MessageRouteRecord;
      text?: string;
      callbackToken?: string;
      callbackAction?: string;
      callbackPayload?: string;
    }
  | { accepted: false; reason: InteractionValidationReason };

function messageBinding(
  update: TelegramUpdate,
  subject: AuthorizedUpdate,
  database: StateDatabase,
): BindingResult {
  const message = update.message;
  const reply = message?.reply_to_message;
  if (!message || !reply) return { accepted: false, reason: "MESSAGE_BINDING_REQUIRED" };
  const route = database.getMessageRoute(subject.chatId, reply.message_id);
  if (!route) return { accepted: false, reason: "MESSAGE_BINDING_NOT_FOUND" };
  return { accepted: true, route, ...(message.text ? { text: message.text } : {}) };
}

function callbackBinding(
  update: TelegramUpdate,
  subject: AuthorizedUpdate,
  database: StateDatabase,
  now: number,
): BindingResult {
  const callback = update.callback_query;
  const tokenValue = callback?.data;
  if (!callback?.message || !tokenValue)
    return { accepted: false, reason: "CALLBACK_TOKEN_INVALID" };
  const token = database.getCallbackToken(tokenValue);
  if (!token) return { accepted: false, reason: "CALLBACK_TOKEN_INVALID" };
  if (token.chatId !== subject.chatId || token.messageId !== callback.message.message_id) {
    return { accepted: false, reason: "CALLBACK_TOKEN_MESSAGE_MISMATCH" };
  }
  if (token.expiresAt <= now || token.consumedAt) {
    return { accepted: false, reason: "CALLBACK_TOKEN_EXPIRED" };
  }
  const route = database.getMessageRoute(token.chatId, token.messageId);
  if (!route) return { accepted: false, reason: "MESSAGE_BINDING_NOT_FOUND" };
  return {
    accepted: true,
    route,
    callbackToken: token.token,
    callbackAction: token.action,
    ...(token.payload ? { callbackPayload: token.payload } : {}),
  };
}

function validateRouteState(
  database: StateDatabase,
  route: MessageRouteRecord,
  now: number,
  isRouteLive: (route: RouteKey) => boolean,
): InteractionValidationReason | undefined {
  if (route.expiresAt <= now) {
    database.setMessageRouteStatus(route.chatId, route.messageId, "expired");
    return "MESSAGE_BINDING_EXPIRED";
  }
  if (route.status !== "active") return "MESSAGE_BINDING_INACTIVE";
  if (!isRouteLive(route.route)) {
    database.setMessageRouteStatus(route.chatId, route.messageId, "offline");
    return "ROUTE_STALE";
  }
  return undefined;
}

function rejected(
  update: TelegramUpdate,
  reason: InteractionValidationReason,
): InteractionValidationResult {
  return {
    accepted: false,
    reason,
    disposition: {
      disposition: "rejected",
      actionId: reason,
      payloadHash: createHash("sha256").update(`${update.update_id}:${reason}`).digest("hex"),
    },
  };
}
