import { type SupportedLocale } from "../i18n";
import type { BrokerCommand, CommandResult, RouteKey } from "../protocol";
import type { MessageRouteKind, StateDatabase } from "../state";
import type { TelegramUpdate } from "./api";
import type { AuthorizedUpdate, TelegramUpdateAuthorizer } from "./authorization";
import type { UpdateDisposition } from "./poller";
export type InteractionValidationReason = "ALREADY_HANDLED" | "MESSAGE_BINDING_REQUIRED" | "MESSAGE_BINDING_NOT_FOUND" | "MESSAGE_BINDING_EXPIRED" | "MESSAGE_BINDING_INACTIVE" | "CALLBACK_TOKEN_INVALID" | "CALLBACK_TOKEN_EXPIRED" | "CALLBACK_TOKEN_MESSAGE_MISMATCH" | "ACTION_KIND_MISMATCH" | "ROUTE_STALE";
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
export type InteractionValidationResult = {
    accepted: true;
    interaction: ValidatedTelegramInteraction;
} | {
    accepted: false;
    reason: InteractionValidationReason;
    disposition: UpdateDisposition;
};
export type InteractionValidatorOptions = {
    database: StateDatabase;
    isRouteLive: (route: RouteKey) => boolean;
    now?: () => number;
};
export type BrokerCommandDispatcher = {
    sendCommand(command: BrokerCommand): Promise<CommandResult>;
};
export type InteractionFeedbackCode = "accepted" | "already_handled" | "expired" | "indeterminate" | "invalid" | "offline" | "rejected" | "reply_required" | "stale" | "terminal_only";
export type InteractionSubmissionOutcome = {
    result: CommandResult;
    feedback: InteractionFeedbackCode;
};
export declare function validateTelegramInteraction(update: TelegramUpdate, subject: AuthorizedUpdate, options: InteractionValidatorOptions): InteractionValidationResult;
export declare function createValidatedInteractionHandler(authorizer: TelegramUpdateAuthorizer, options: InteractionValidatorOptions, handleValidated: (interaction: ValidatedTelegramInteraction, update: TelegramUpdate) => UpdateDisposition | Promise<UpdateDisposition>): (update: TelegramUpdate) => UpdateDisposition | Promise<UpdateDisposition>;
export declare function submitCompletedSessionReply(dispatcher: BrokerCommandDispatcher, interaction: ValidatedTelegramInteraction): Promise<CommandResult>;
export declare function submitQuestionReply(dispatcher: BrokerCommandDispatcher, interaction: ValidatedTelegramInteraction): Promise<CommandResult>;
export declare function submitPermissionReply(dispatcher: BrokerCommandDispatcher, interaction: ValidatedTelegramInteraction): Promise<CommandResult>;
export declare function submitTelegramInteraction(dispatcher: BrokerCommandDispatcher, interaction: ValidatedTelegramInteraction): Promise<InteractionSubmissionOutcome>;
export declare function validationFeedback(reason: InteractionValidationReason): InteractionFeedbackCode;
export declare function interactionFeedbackText(locale: SupportedLocale, feedback: InteractionFeedbackCode): string;
//# sourceMappingURL=interaction.d.ts.map