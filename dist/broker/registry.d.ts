import type { ServerWebSocket } from "bun";
import { type RouteKey } from "../protocol";
export type BrokerConnectionData = {
    connectionId: string;
    connectedAt: number;
    lastHeartbeatAt: number;
    instanceId?: string;
};
export type RegisteredRoute = {
    route: RouteKey;
    hostLabel?: string | undefined;
    projectLabel: string;
    sessionLabel: string;
    connectionId: string;
};
type OwnedConnection = {
    socket: ServerWebSocket<BrokerConnectionData>;
    instanceId: string;
    machineId: string;
    hostLabel?: string | undefined;
    projectLabel?: string | undefined;
    routeKeys: Set<string>;
};
export declare class RouteRegistry {
    #private;
    registerConnection(socket: ServerWebSocket<BrokerConnectionData>, instanceId: string, machineId: string, hostLabel?: string, projectLabel?: string): void;
    registerRoute(connectionId: string, input: {
        route: RouteKey;
        hostLabel?: string | undefined;
        projectLabel: string;
        sessionLabel: string;
    }): RegisteredRoute;
    unregisterRoute(connectionId: string, route: RouteKey): boolean;
    resolve(route: RouteKey): RegisteredRoute | undefined;
    resolveBySessionId(sessionId: string, target?: string): RouteKey | undefined;
    owner(route: RouteKey): ServerWebSocket<BrokerConnectionData> | undefined;
    ownerByInstance(instanceId: string): ServerWebSocket<BrokerConnectionData> | undefined;
    removeConnection(connectionId: string): void;
    get connectionCount(): number;
    get routeCount(): number;
    listNodes(): Array<{
        connectionId: string;
        machineId: string;
        instanceId: string;
        hostLabel?: string;
        activeRoutesCount: number;
        lastHeartbeatAt?: number;
    }>;
    listMachines(): Array<{
        machineId: string;
        hostLabel: string;
        connectionsCount: number;
        totalRoutesCount: number;
        projects: Array<{
            projectLabel: string;
            sessionLabel?: string;
            sessionId?: string;
        }>;
    }>;
    findConnection(target?: string): OwnedConnection | undefined;
    listActiveSessions(): Array<{
        route: RouteKey;
        projectLabel: string;
        sessionLabel: string;
        hostLabel?: string;
    }>;
}
export declare class RouteRegistrationError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function serializeRouteKey(route: RouteKey): string;
export {};
//# sourceMappingURL=registry.d.ts.map