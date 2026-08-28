import { z } from "zod";
import { type BrokerCommand, type CommandResult, type NormalizedNotification, type TelegramRuntimeConfig } from "../protocol";
import { StateDatabase } from "../state";
import { TelegramBotApi, VoiceTranscriber } from "../telegram";
import { type BrokerConnectionData, RouteRegistry } from "./registry";
declare const LOOPBACK_HOST = "127.0.0.1";
declare const CONTAINER_HOST = "0.0.0.0";
export type DashboardSettings = {
    activeProvider?: "groq" | "openai" | "cloudflare" | "custom" | undefined;
    cloudflare?: {
        accountId?: string | undefined;
        apiToken?: string | undefined;
    } | undefined;
    groq?: {
        apiKey?: string | undefined;
    } | undefined;
    openai?: {
        apiKey?: string | undefined;
    } | undefined;
    custom?: {
        endpoint?: string | undefined;
        apiKey?: string | undefined;
        model?: string | undefined;
    } | undefined;
    sessionPromptTtlMinutes?: number | undefined;
    voiceProvider?: "groq" | "openai" | "cloudflare" | "custom" | undefined;
    voiceApiKey?: string | undefined;
    voiceAccountId?: string | undefined;
    voiceEndpoint?: string | undefined;
    voiceModel?: string | undefined;
};
declare const HealthResponseSchema: z.ZodObject<{
    service: z.ZodLiteral<"opencode-telegram-link">;
    machineId: z.ZodUUID;
    protocol: z.ZodObject<{
        major: z.ZodNumber;
        minor: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
declare const BrokerStatusSchema: z.ZodObject<{
    service: z.ZodLiteral<"opencode-telegram-link">;
    machineId: z.ZodUUID;
    protocol: z.ZodObject<{
        major: z.ZodNumber;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    bindHost: z.ZodEnum<{
        "0.0.0.0": "0.0.0.0";
        "127.0.0.1": "127.0.0.1";
    }>;
    connections: z.ZodNumber;
    routes: z.ZodNumber;
}, z.core.$strip>;
export type StartBrokerOptions = {
    stateDirectory?: string;
    bindHost?: typeof LOOPBACK_HOST | typeof CONTAINER_HOST;
    port?: number;
    registrationTimeoutMs?: number;
    heartbeatTimeoutMs?: number;
    idleTimeoutMs?: number;
    maintenanceIntervalMs?: number;
    telegramApiFactory?: (botToken: string) => TelegramBotApi;
    telegramDeliveryIntervalMs?: number;
    telegramPollLongPollSeconds?: number;
    now?: () => number;
};
export type StartOrReuseBrokerResult = {
    kind: "started";
    broker: BrokerServer;
} | {
    kind: "existing";
    machineId: string;
    port: number;
};
export declare class BrokerServer {
    #private;
    readonly machineId: string;
    readonly registry: RouteRegistry;
    readonly database: StateDatabase;
    readonly port: number;
    readonly finished: Promise<void>;
    constructor(input: {
        server: Bun.Server<BrokerConnectionData>;
        machineId: string;
        registry: RouteRegistry;
        database: StateDatabase;
        connections: Set<Bun.ServerWebSocket<BrokerConnectionData>>;
        livenessTimer: ReturnType<typeof setInterval>;
        maintenanceTimer: ReturnType<typeof setInterval>;
        removeDiscovery: () => Promise<void>;
        pendingCommands: Map<string, PendingBrokerCommand>;
        telegramRuntimeRef: {
            value: BrokerTelegramRuntime | undefined;
        };
    });
    stop(): Promise<void>;
    sendCommand(command: BrokerCommand, timeoutMs?: number): Promise<CommandResult>;
}
export declare function startBroker(options?: StartBrokerOptions): Promise<BrokerServer>;
export declare function startOrReuseBroker(options?: StartBrokerOptions): Promise<StartOrReuseBrokerResult>;
export declare function probeBroker(port: number, brokerSecret: string): Promise<z.infer<typeof HealthResponseSchema> | undefined>;
export declare function fetchBrokerStatus(port: number, brokerSecret: string): Promise<z.infer<typeof BrokerStatusSchema> | undefined>;
export declare class BrokerPortConflictError extends Error {
    readonly port: number;
    constructor(port: number);
}
declare class BrokerTelegramRuntime {
    #private;
    setTranscriber(transcriber: VoiceTranscriber | undefined): void;
    constructor(input: {
        config: TelegramRuntimeConfig;
        database: StateDatabase;
        registry: RouteRegistry;
        dispatcher: {
            sendCommand(command: BrokerCommand): Promise<CommandResult>;
        };
        api: TelegramBotApi;
        deliveryIntervalMs: number;
        pollLongPollSeconds?: number;
        now: () => number;
    });
    start(): void;
    stop(): Promise<void>;
    publish(notification: NormalizedNotification): "queued" | "duplicate";
}
type PendingBrokerCommand = {
    connectionId: string;
    commandId: string;
    resolve: (result: CommandResult) => void;
    timeout: ReturnType<typeof setTimeout>;
};
export {};
//# sourceMappingURL=server.d.ts.map