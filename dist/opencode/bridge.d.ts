import type { SupportedLocale } from "../i18n";
import type { RouteIntent } from "../plugin/client";
import type { NormalizedNotification, RouteKey } from "../protocol";
type RouteClient = {
    upsertRoute(intent: RouteIntent): Promise<RouteKey | undefined>;
    removeRoute(projectId: string, sessionId: string): Promise<void>;
    activeRoute(projectId: string, sessionId: string): RouteKey | undefined;
};
type NotificationFilters = {
    completion: boolean;
    error: boolean;
    question: boolean;
    permission: boolean;
};
export type OpenCodeEventBridgeOptions = {
    broker: RouteClient;
    projectId: string;
    projectLabel: string;
    locale: SupportedLocale;
    now?: () => Date;
    notificationFilters?: Partial<NotificationFilters>;
    includeChildLifecycle?: boolean;
    completionDebounceMs?: number;
    bufferLimit?: number;
    dedupeTtlMs?: number;
    fetchSummary?: (sessionId: string) => Promise<string | undefined>;
    onNotification: (notification: NormalizedNotification) => void | Promise<void>;
    onDiagnostic?: (code: string, eventType: string) => void;
};
export declare class OpenCodeEventBridge {
    #private;
    constructor(options: OpenCodeEventBridgeOptions);
    dispose(): void;
    flush(): Promise<void>;
    handle(input: unknown): Promise<void>;
}
export {};
//# sourceMappingURL=bridge.d.ts.map