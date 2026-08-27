import { type BrokerCommand, type CommandResult, type NormalizedNotification, type RouteKey, type TelegramRuntimeConfig } from "../protocol";
export declare function probeBroker(port: number, brokerSecret: string): Promise<{
    status: "ok";
    machineId: string;
} | undefined>;
export type RouteIntent = {
    projectId: string;
    sessionId: string;
    projectLabel: string;
    sessionLabel: string;
};
export type BrokerClientOptions = {
    stateDirectory?: string;
    port?: number;
    hostLabel?: string | undefined;
    gatewayUrl?: string | undefined;
    gatewaySecret?: string | undefined;
    packageVersion: string;
    openCodeVersion: string;
    startupTimeoutMs?: number;
    requestTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    reconnectMinDelayMs?: number;
    reconnectMaxDelayMs?: number;
    configFingerprint?: string;
    spawnBroker?: (input: {
        stateDirectory: string;
        port: number;
    }) => void | Promise<void>;
    random?: () => number;
    onCommand?: (command: BrokerCommand) => CommandResult | Promise<CommandResult>;
    onDiagnostic?: (code: string, message: string) => void;
    telegram?: TelegramRuntimeConfig;
};
export declare class BrokerClient {
    #private;
    readonly instanceId: `${string}-${string}-${string}-${string}-${string}`;
    constructor(options: BrokerClientOptions);
    get connected(): boolean;
    start(): Promise<void>;
    stop(): Promise<void>;
    waitUntilConnected(timeoutMs?: number): Promise<void>;
    upsertRoute(intent: RouteIntent): Promise<RouteKey | undefined>;
    removeRoute(projectId: string, sessionId: string): Promise<void>;
    activeRoute(projectId: string, sessionId: string): RouteKey | undefined;
    publishNotification(notification: NormalizedNotification): Promise<"queued" | "duplicate">;
}
export declare function spawnDetachedBroker(input: {
    stateDirectory: string;
    port: number;
}): void;
export declare function brokerRuntimeCommand(): {
    command: string;
    args: string[];
};
//# sourceMappingURL=client.d.ts.map