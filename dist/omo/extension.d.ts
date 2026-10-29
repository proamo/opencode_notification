import { type SupportedLocale } from "../i18n";
import { type RouteIntent } from "../plugin/client";
import type { BrokerCommand, CommandResult, NormalizedNotification, NormalizedQuestion, RouteKey } from "../protocol";
type OmoMessage = {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
};
export type OmoEntry = {
    type: string;
    message?: OmoMessage;
};
export type OmoSessionManager = {
    getSessionId(): string;
    getSessionName(): string | undefined;
    getHeader(): {
        spawnedBy?: unknown;
    } | null | undefined;
    getBranch(): OmoEntry[];
    getLeafId(): string | null | undefined;
};
export type OmoContext = {
    cwd: string;
    sessionManager: OmoSessionManager;
    isIdle?: () => boolean;
};
export type UiPromptEvent = {
    kind?: string;
    title?: string;
};
export type AskUserAskedEvent = {
    ctx?: OmoContext;
    request?: unknown;
};
export type OmoExtensionApi = {
    sessionKind?: "interactive" | "worker";
    on(event: "agent_settled" | "session_start" | "session_shutdown", handler: (event: unknown, ctx: OmoContext) => Promise<void> | void): void;
    on(event: "ui_prompt_start", handler: (event: UiPromptEvent, ctx: OmoContext) => Promise<void>): void;
    events?: {
        on(channel: "ask-user:asked", handler: (data: AskUserAskedEvent) => void): unknown;
    };
    sendUserMessage?(text: string, options?: {
        deliverAs?: "steer" | "followUp";
    }): void;
};
export type OmoSessionInbox = Map<string, (text: string) => void>;
export type SettledOutcome = {
    kind: "session.completed";
    summary?: string;
} | {
    kind: "session.error";
    errorCategory: string;
};
type PendingQuestion = {
    kind: "question.pending";
    interactionId: string;
    questions: NormalizedQuestion[];
};
export type OmoGateway = {
    projectId: string;
    projectLabel: string;
    hostLabel?: string | undefined;
    locale: SupportedLocale;
    notifyCompletion: boolean;
    notifyError: boolean;
    notifyQuestion: boolean;
    broker: {
        readonly connected?: boolean;
        stop?(): Promise<void>;
        upsertRoute(intent: RouteIntent): Promise<RouteKey | undefined>;
        publishNotification(notification: NormalizedNotification): Promise<"queued" | "duplicate">;
    };
};
export declare function resolveSettledOutcome(entries: readonly OmoEntry[]): SettledOutcome | undefined;
export declare function normalizeAskUserRequest(request: unknown): PendingQuestion | undefined;
export declare function uiPromptQuestion(event: UiPromptEvent, interactionId: string): PendingQuestion;
export declare function handleOmoCommand(command: BrokerCommand, inbox: OmoSessionInbox): CommandResult;
export declare function createOmoExtension(connect: (cwd: string) => Promise<OmoGateway | undefined>, onDiagnostic?: (message: string) => void, inbox?: OmoSessionInbox): (pi: OmoExtensionApi) => void;
declare const _default: (pi: OmoExtensionApi) => void;
export default _default;
//# sourceMappingURL=extension.d.ts.map