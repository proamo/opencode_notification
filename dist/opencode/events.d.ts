import type { NormalizedQuestion } from "../protocol";
export type SessionSourceEvent = {
    kind: "session.upsert" | "session.delete";
    sessionId: string;
    title: string;
    parentId?: string;
} | {
    kind: "session.busy";
    sessionId: string;
};
export type NotificationSourceEvent = {
    kind: "session.completed";
    sessionId: string;
    sourceEventId?: string;
} | {
    kind: "session.error";
    sessionId: string;
    errorCategory: string;
    sourceEventId?: string;
} | {
    kind: "question.pending";
    sessionId: string;
    interactionId: string;
    questions: NormalizedQuestion[];
    sourceEventId?: string;
} | {
    kind: "permission.pending";
    sessionId: string;
    interactionId: string;
    permissionCategory: string;
    sourceEventId?: string;
};
export type OpenCodeEventResult = {
    status: "session";
    event: SessionSourceEvent;
} | {
    status: "notification";
    event: NotificationSourceEvent;
} | {
    status: "ignored";
} | {
    status: "invalid";
    eventType: string;
    code: string;
};
export declare function normalizeOpenCodeEvent(input: unknown): OpenCodeEventResult;
//# sourceMappingURL=events.d.ts.map