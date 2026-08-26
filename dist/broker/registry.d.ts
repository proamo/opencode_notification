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
    projectLabel: string;
    sessionLabel: string;
    connectionId: string;
};
export declare class RouteRegistry {
    #private;
    constructor(machineId: string);
    registerConnection(socket: ServerWebSocket<BrokerConnectionData>, instanceId: string, machineId: string): void;
    registerRoute(connectionId: string, input: {
        route: RouteKey;
        projectLabel: string;
        sessionLabel: string;
    }): RegisteredRoute;
    unregisterRoute(connectionId: string, route: RouteKey): boolean;
    resolve(route: RouteKey): RegisteredRoute | undefined;
    owner(route: RouteKey): ServerWebSocket<BrokerConnectionData> | undefined;
    removeConnection(connectionId: string): void;
    get connectionCount(): number;
    get routeCount(): number;
}
export declare class RouteRegistrationError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function serializeRouteKey(route: RouteKey): string;
//# sourceMappingURL=registry.d.ts.map