import { z } from "zod";
import type { StateDatabase } from "../state";
import { type TelegramBotApi } from "./api";
export declare const TelegramOutboxPayloadSchema: z.ZodObject<{
    text: z.ZodString;
    parseMode: z.ZodOptional<z.ZodLiteral<"HTML">>;
    disableNotification: z.ZodOptional<z.ZodBoolean>;
    replyMarkup: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    binding: z.ZodOptional<z.ZodObject<{
        route: z.ZodObject<{
            machineId: z.ZodUUID;
            instanceId: z.ZodUUID;
            projectId: z.ZodString;
            sessionId: z.ZodString;
            routeGeneration: z.ZodUUID;
        }, z.core.$strip>;
        kind: z.ZodEnum<{
            session_prompt: "session_prompt";
            question_reply: "question_reply";
            permission_notice: "permission_notice";
            informational: "informational";
        }>;
        interactionId: z.ZodOptional<z.ZodString>;
        expiresAt: z.ZodNumber;
        callbackButtons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            text: z.ZodString;
            action: z.ZodString;
            payload: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type TelegramOutboxPayload = z.infer<typeof TelegramOutboxPayloadSchema>;
export type TelegramOutboxWorkerOptions = {
    api: TelegramBotApi;
    database: StateDatabase;
    maxAttempts?: number;
    retryMinDelayMs?: number;
    retryMaxDelayMs?: number;
    random?: () => number;
};
export declare class TelegramOutboxWorker {
    #private;
    constructor(options: TelegramOutboxWorkerOptions);
    deliverBatch(now: number, limit?: number): Promise<number>;
}
//# sourceMappingURL=outbox.d.ts.map