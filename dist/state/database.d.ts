import type { RouteKey } from "../protocol";
export type MessageRouteKind = "session_prompt" | "question_reply" | "permission_notice" | "informational";
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
export type InboundUpdateRecord = {
    updateId: number;
    actionId?: string;
    disposition: "rejected" | "acknowledged" | "failed";
    payloadHash?: string;
    occurredAt: number;
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
export declare const DEFAULT_RETENTION_POLICY: RetentionPolicy;
export declare class StateDatabase {
    #private;
    readonly path: string;
    private constructor();
    static open(input: {
        stateDirectory: string;
        machineId: string;
    }): Promise<StateDatabase>;
    get schemaVersion(): number;
    getTelegramUpdateOffset(): number;
    getTelegramBotFingerprint(): string | undefined;
    pinTelegramBotFingerprint(botId: string, force?: boolean): void;
    setTelegramBotFingerprint(botId: string): void;
    commitInboundUpdate(input: {
        updateId: number;
        actionId?: string;
        disposition: "rejected" | "acknowledged" | "failed";
        payloadHash?: string;
        occurredAt: number;
    }): boolean;
    getInboundUpdate(updateId: number): InboundUpdateRecord | undefined;
    saveMessageRoute(record: MessageRouteRecord): void;
    getMessageRoute(chatId: string, messageId: number): MessageRouteRecord | undefined;
    setMessageRouteStatus(chatId: string, messageId: number, status: MessageRouteStatus): boolean;
    saveCallbackToken(record: CallbackTokenRecord): void;
    getCallbackToken(token: string): CallbackTokenRecord | undefined;
    consumeCallbackToken(token: string, now: number): boolean;
    consumeCallbackTokenAndRoute(input: {
        token: string;
        chatId: string;
        messageId: number;
        now: number;
    }): boolean;
    enqueueOutbox(input: {
        idempotencyKey: string;
        chatId: string;
        payload: string;
        priority: number;
        nextAttemptAt: number;
        expiresAt: number;
        createdAt: number;
    }): {
        id: number;
        created: boolean;
    };
    nextOutbox(now: number, limit: number): OutboxRecord[];
    recordOutboxRetry(id: number, nextAttemptAt: number, resultCode: string, now: number): void;
    finishOutbox(id: number, status: "delivered" | "failed", resultCode: string | null, now: number): void;
    finishOutboxDeliveryWithBinding(input: {
        outboxId: number;
        route: MessageRouteRecord;
        callbackTokens?: CallbackTokenRecord[];
        now: number;
    }): void;
    claimNotification(idempotencyKey: string, expiresAt: number, now: number): boolean;
    cleanup(now: number, policy?: RetentionPolicy): CleanupResult;
    inspect(): StateInspection;
    purgeOperationalState(): StateInspection;
    vacuum(): void;
    close(): void;
}
export declare class DatabaseVersionError extends Error {
    readonly found: number;
    readonly supported: number;
    constructor(found: number, supported: number);
}
export type DatabaseIntegrity = {
    status: "missing";
} | {
    status: "healthy";
} | {
    status: "corrupt";
    reason: string;
};
export declare function inspectDatabaseIntegrity(stateDirectory: string): Promise<DatabaseIntegrity>;
export declare function repairCorruptStateDatabase(input: {
    stateDirectory: string;
    machineId: string;
    confirm: boolean;
    force?: boolean;
}): Promise<{
    archivePath: string;
    previousIntegrity: DatabaseIntegrity;
}>;
//# sourceMappingURL=database.d.ts.map