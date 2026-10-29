import { type SupportedLocale } from "../i18n";
import { type RouteIntent } from "../plugin/client";
import type { NormalizedNotification, RouteKey } from "../protocol";
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
};
export type OmoExtensionApi = {
    sessionKind?: "interactive" | "worker";
    on(event: "agent_settled", handler: (event: unknown, ctx: OmoContext) => Promise<void>): void;
};
export type SettledOutcome = {
    kind: "session.completed";
    summary?: string;
} | {
    kind: "session.error";
    errorCategory: string;
};
export type OmoGateway = {
    projectId: string;
    projectLabel: string;
    hostLabel?: string | undefined;
    locale: SupportedLocale;
    notifyCompletion: boolean;
    notifyError: boolean;
    broker: {
        upsertRoute(intent: RouteIntent): Promise<RouteKey | undefined>;
        publishNotification(notification: NormalizedNotification): Promise<"queued" | "duplicate">;
    };
};
export declare function resolveSettledOutcome(entries: readonly OmoEntry[]): SettledOutcome | undefined;
export declare function createOmoExtension(connect: (cwd: string) => Promise<OmoGateway | undefined>, onDiagnostic?: (message: string) => void): (pi: OmoExtensionApi) => void;
declare const _default: (pi: OmoExtensionApi) => void;
export default _default;
//# sourceMappingURL=extension.d.ts.map