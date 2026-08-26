import { z } from "zod";
export declare const TelegramUpdateSchema: z.ZodObject<{
    update_id: z.ZodNumber;
    message: z.ZodOptional<z.ZodObject<{
        message_id: z.ZodNumber;
        from: z.ZodOptional<z.ZodObject<{
            id: z.ZodNumber;
            is_bot: z.ZodBoolean;
            first_name: z.ZodString;
            username: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        chat: z.ZodObject<{
            id: z.ZodNumber;
            type: z.ZodEnum<{
                private: "private";
                group: "group";
                supergroup: "supergroup";
                channel: "channel";
            }>;
        }, z.core.$strip>;
        date: z.ZodNumber;
        text: z.ZodOptional<z.ZodString>;
        sender_chat: z.ZodOptional<z.ZodObject<{
            id: z.ZodNumber;
            type: z.ZodEnum<{
                private: "private";
                group: "group";
                supergroup: "supergroup";
                channel: "channel";
            }>;
        }, z.core.$strip>>;
        forward_origin: z.ZodOptional<z.ZodUnknown>;
        author_signature: z.ZodOptional<z.ZodString>;
        business_connection_id: z.ZodOptional<z.ZodString>;
        reply_to_message: z.ZodOptional<z.ZodObject<{
            message_id: z.ZodNumber;
            chat: z.ZodObject<{
                id: z.ZodNumber;
                type: z.ZodEnum<{
                    private: "private";
                    group: "group";
                    supergroup: "supergroup";
                    channel: "channel";
                }>;
            }, z.core.$strip>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    callback_query: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        from: z.ZodObject<{
            id: z.ZodNumber;
            is_bot: z.ZodBoolean;
            first_name: z.ZodString;
            username: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        message: z.ZodOptional<z.ZodObject<{
            message_id: z.ZodNumber;
            from: z.ZodOptional<z.ZodObject<{
                id: z.ZodNumber;
                is_bot: z.ZodBoolean;
                first_name: z.ZodString;
                username: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            chat: z.ZodObject<{
                id: z.ZodNumber;
                type: z.ZodEnum<{
                    private: "private";
                    group: "group";
                    supergroup: "supergroup";
                    channel: "channel";
                }>;
            }, z.core.$strip>;
            date: z.ZodNumber;
            text: z.ZodOptional<z.ZodString>;
            sender_chat: z.ZodOptional<z.ZodObject<{
                id: z.ZodNumber;
                type: z.ZodEnum<{
                    private: "private";
                    group: "group";
                    supergroup: "supergroup";
                    channel: "channel";
                }>;
            }, z.core.$strip>>;
            forward_origin: z.ZodOptional<z.ZodUnknown>;
            author_signature: z.ZodOptional<z.ZodString>;
            business_connection_id: z.ZodOptional<z.ZodString>;
            reply_to_message: z.ZodOptional<z.ZodObject<{
                message_id: z.ZodNumber;
                chat: z.ZodObject<{
                    id: z.ZodNumber;
                    type: z.ZodEnum<{
                        private: "private";
                        group: "group";
                        supergroup: "supergroup";
                        channel: "channel";
                    }>;
                }, z.core.$strip>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        data: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;
export declare const TelegramBotSchema: z.ZodObject<{
    id: z.ZodNumber;
    first_name: z.ZodString;
    username: z.ZodOptional<z.ZodString>;
    is_bot: z.ZodLiteral<true>;
}, z.core.$strip>;
export type TelegramBot = z.infer<typeof TelegramBotSchema>;
export type SendMessageInput = {
    chatId: string;
    text: string;
    parseMode?: "HTML";
    disableNotification?: boolean;
    replyMarkup?: Record<string, unknown>;
    signal?: AbortSignal;
};
export type TelegramBotApiOptions = {
    token: string;
    baseUrl?: string;
    fetch?: typeof fetch;
};
export declare class TelegramBotApi {
    #private;
    constructor(options: TelegramBotApiOptions);
    getMe(signal?: AbortSignal): Promise<TelegramBot>;
    deleteWebhook(signal?: AbortSignal): Promise<void>;
    getUpdates(input: {
        offset: number;
        timeoutSeconds?: number;
        signal?: AbortSignal;
    }): Promise<TelegramUpdate[]>;
    sendMessage(input: SendMessageInput): Promise<{
        messageId: number;
        chatId: string;
    }>;
    answerCallbackQuery(input: {
        callbackQueryId: string;
        text?: string;
        showAlert?: boolean;
        signal?: AbortSignal;
    }): Promise<boolean>;
    editMessageText(input: {
        chatId: string;
        messageId: number;
        text: string;
        parseMode?: "HTML";
        replyMarkup?: Record<string, unknown>;
        signal?: AbortSignal;
    }): Promise<{
        messageId: number;
        chatId: string;
    }>;
}
export declare class TelegramApiError extends Error {
    readonly method: string;
    readonly statusCode: number;
    readonly errorCode: number | undefined;
    readonly retryAfterSeconds: number | undefined;
    readonly retryable: boolean;
    constructor(input: {
        method: string;
        statusCode: number;
        errorCode?: number;
        description: string;
        retryAfterSeconds?: number;
        retryable: boolean;
    });
    get authenticationFailed(): boolean;
    get pollingConflict(): boolean;
}
//# sourceMappingURL=api.d.ts.map