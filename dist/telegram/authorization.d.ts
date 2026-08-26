import type { TelegramUpdate } from "./api";
import type { UpdateDisposition } from "./poller";
export type AuthorizationRejection = "UNSUPPORTED_UPDATE" | "USER_MISSING" | "BOT_SENDER" | "USER_MISMATCH" | "CHAT_MISSING" | "CHAT_NOT_PRIVATE" | "CHAT_MISMATCH" | "FORWARDED_MESSAGE" | "SENDER_CHAT" | "BUSINESS_MESSAGE";
export type AuthorizedUpdate = {
    kind: "message" | "callback_query";
    userId: string;
    chatId: string;
};
export type AuthorizationResult = {
    authorized: true;
    subject: AuthorizedUpdate;
} | {
    authorized: false;
    reason: AuthorizationRejection;
};
export declare class TelegramUpdateAuthorizer {
    #private;
    constructor(input: {
        userId: string;
        chatId: string;
    });
    authorize(update: TelegramUpdate): AuthorizationResult;
}
export declare function createAuthorizedUpdateHandler(authorizer: TelegramUpdateAuthorizer, handleAuthorized: (update: TelegramUpdate, subject: AuthorizedUpdate) => UpdateDisposition | Promise<UpdateDisposition>): (update: TelegramUpdate) => UpdateDisposition | Promise<UpdateDisposition>;
//# sourceMappingURL=authorization.d.ts.map