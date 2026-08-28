import type { ServerWebSocket } from "bun";
import { type RouteKey, RouteKeySchema } from "../protocol";

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

export class RouteRegistry {
  readonly #connections = new Map<string, OwnedConnection>();
  readonly #instances = new Map<string, string>();
  readonly #routes = new Map<string, RegisteredRoute>();

  registerConnection(
    socket: ServerWebSocket<BrokerConnectionData>,
    instanceId: string,
    machineId: string,
    hostLabel?: string,
    projectLabel?: string,
  ): void {
    const currentOwner = this.#instances.get(instanceId);
    if (currentOwner && currentOwner !== socket.data.connectionId) {
      throw new RouteRegistrationError(
        "INSTANCE_ALREADY_REGISTERED",
        "instance is already owned by another connection",
      );
    }

    const existing = this.#connections.get(socket.data.connectionId);
    if (existing && existing.instanceId !== instanceId) {
      throw new RouteRegistrationError(
        "CONNECTION_ALREADY_REGISTERED",
        "connection cannot change instance identity",
      );
    }

    this.#connections.set(socket.data.connectionId, {
      socket,
      instanceId,
      machineId,
      hostLabel,
      projectLabel,
      routeKeys: existing?.routeKeys ?? new Set(),
    });
    this.#instances.set(instanceId, socket.data.connectionId);
    socket.data.instanceId = instanceId;
  }

  registerRoute(
    connectionId: string,
    input: {
      route: RouteKey;
      hostLabel?: string | undefined;
      projectLabel: string;
      sessionLabel: string;
    },
  ): RegisteredRoute {
    const connection = this.#connections.get(connectionId);
    if (!connection) {
      throw new RouteRegistrationError("NOT_REGISTERED", "connection must register first");
    }

    const route = RouteKeySchema.parse(input.route);
    if (route.machineId !== connection.machineId) {
      throw new RouteRegistrationError(
        "MACHINE_MISMATCH",
        "route machine does not match connection",
      );
    }
    if (route.instanceId !== connection.instanceId) {
      throw new RouteRegistrationError(
        "INSTANCE_MISMATCH",
        "route instance is not owned by this connection",
      );
    }

    const key = serializeRouteKey(route);
    const current = this.#routes.get(key);
    if (current && current.connectionId !== connectionId) {
      throw new RouteRegistrationError(
        "ROUTE_ALREADY_REGISTERED",
        "exact route is already owned by another connection",
      );
    }

    for (const ownedKey of connection.routeKeys) {
      const owned = this.#routes.get(ownedKey);
      if (owned && ownedKey !== key && sameSessionRoute(owned.route, route)) {
        this.#routes.delete(ownedKey);
        connection.routeKeys.delete(ownedKey);
      }
    }

    const registered: RegisteredRoute = {
      ...input,
      hostLabel: input.hostLabel ?? connection.hostLabel,
      route,
      connectionId,
    };
    this.#routes.set(key, registered);
    connection.routeKeys.add(key);
    return registered;
  }

  unregisterRoute(connectionId: string, route: RouteKey): boolean {
    const key = serializeRouteKey(RouteKeySchema.parse(route));
    const current = this.#routes.get(key);
    if (!current || current.connectionId !== connectionId) return false;

    this.#routes.delete(key);
    this.#connections.get(connectionId)?.routeKeys.delete(key);
    return true;
  }

  resolve(route: RouteKey): RegisteredRoute | undefined {
    const parsed = RouteKeySchema.parse(route);
    const exact = this.#routes.get(serializeRouteKey(parsed));
    if (exact) return exact;

    // Hot fallback: match strictly by (machineId, projectId, sessionId) across active registered routes in the same project
    for (const registered of this.#routes.values()) {
      if (
        registered.route.machineId === parsed.machineId &&
        registered.route.projectId === parsed.projectId &&
        registered.route.sessionId === parsed.sessionId
      ) {
        return registered;
      }
    }

    return undefined;
  }

  resolveBySessionId(sessionId: string): RouteKey | undefined {
    for (const registered of this.#routes.values()) {
      if (registered.route.sessionId === sessionId) {
        return registered.route;
      }
    }
    return undefined;
  }

  owner(route: RouteKey): ServerWebSocket<BrokerConnectionData> | undefined {
    const registered = this.resolve(route);
    if (!registered) return undefined;
    return this.#connections.get(registered.connectionId)?.socket;
  }

  ownerByInstance(instanceId: string): ServerWebSocket<BrokerConnectionData> | undefined {
    const connectionId = this.#instances.get(instanceId);
    if (!connectionId) return undefined;
    return this.#connections.get(connectionId)?.socket;
  }

  removeConnection(connectionId: string): void {
    const connection = this.#connections.get(connectionId);
    if (!connection) return;

    for (const key of connection.routeKeys) this.#routes.delete(key);
    if (this.#instances.get(connection.instanceId) === connectionId) {
      this.#instances.delete(connection.instanceId);
    }
    this.#connections.delete(connectionId);
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get routeCount(): number {
    return this.#routes.size;
  }

  listNodes(): Array<{
    connectionId: string;
    machineId: string;
    instanceId: string;
    hostLabel?: string;
    activeRoutesCount: number;
    lastHeartbeatAt?: number;
  }> {
    const nodes = [];
    for (const [connectionId, conn] of this.#connections) {
      nodes.push({
        connectionId,
        machineId: conn.machineId,
        instanceId: conn.instanceId,
        ...(conn.hostLabel ? { hostLabel: conn.hostLabel } : {}),
        activeRoutesCount: conn.routeKeys.size,
        ...(conn.socket.data.lastHeartbeatAt
          ? { lastHeartbeatAt: conn.socket.data.lastHeartbeatAt }
          : {}),
      });
    }
    return nodes;
  }

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
  }> {
    const machineMap = new Map<
      string,
      {
        machineId: string;
        hostLabel: string;
        connectionsCount: number;
        totalRoutesCount: number;
        projects: Array<{
          projectLabel: string;
          sessionLabel?: string;
          sessionId?: string;
        }>;
      }
    >();

    for (const conn of this.#connections.values()) {
      const label = conn.hostLabel || "codeCenter";
      let machine = machineMap.get(conn.machineId);
      if (!machine) {
        machine = {
          machineId: conn.machineId,
          hostLabel: label,
          connectionsCount: 0,
          totalRoutesCount: 0,
          projects: [],
        };
        machineMap.set(conn.machineId, machine);
      }
      machine.connectionsCount += 1;
      machine.totalRoutesCount += conn.routeKeys.size;
      if (conn.hostLabel) {
        machine.hostLabel = conn.hostLabel;
      }

      // Collect all active routes belonging to this connection
      let primaryProjectLabel = conn.projectLabel;
      const activeSessions: Array<{ sessionId: string; sessionLabel: string }> = [];

      for (const routeKey of conn.routeKeys) {
        const reg = this.#routes.get(routeKey);
        if (reg) {
          if (!primaryProjectLabel) {
            primaryProjectLabel = reg.projectLabel;
          }
          activeSessions.push({
            sessionId: reg.route.sessionId,
            sessionLabel: reg.sessionLabel,
          });
        }
      }

      const finalProjectLabel = primaryProjectLabel || `專案視窗 (${conn.instanceId.slice(0, 6)})`;

      const firstSession = activeSessions[0];
      if (firstSession) {
        const sessionCountSuffix =
          activeSessions.length > 1 ? ` (+${activeSessions.length - 1} 個任務)` : "";
        machine.projects.push({
          projectLabel: finalProjectLabel,
          sessionLabel: `${firstSession.sessionLabel}${sessionCountSuffix}`,
          sessionId: firstSession.sessionId,
        });
      } else {
        machine.projects.push({
          projectLabel: finalProjectLabel,
        });
      }
    }

    return Array.from(machineMap.values());
  }

  findConnection(target?: string): OwnedConnection | undefined {
    if (!target) {
      if (this.#connections.size === 1) {
        return this.#connections.values().next().value;
      }
      return undefined;
    }

    const lower = target.toLowerCase().trim();

    // 1. Exact or prefix match on instanceId / machineId
    for (const conn of this.#connections.values()) {
      if (
        conn.instanceId.toLowerCase().startsWith(lower) ||
        conn.machineId.toLowerCase().startsWith(lower)
      ) {
        return conn;
      }
    }

    // 2. Exact match on projectLabel
    for (const conn of this.#connections.values()) {
      if (conn.projectLabel?.toLowerCase() === lower) {
        return conn;
      }
    }

    // 3. Substring match on projectLabel
    for (const conn of this.#connections.values()) {
      if (conn.projectLabel?.toLowerCase().includes(lower)) {
        return conn;
      }
    }

    // 4. Match on hostLabel
    for (const conn of this.#connections.values()) {
      if (conn.hostLabel?.toLowerCase().includes(lower)) {
        return conn;
      }
    }

    // 5. Match on active routes' projectLabel
    for (const reg of this.#routes.values()) {
      if (reg.projectLabel.toLowerCase().includes(lower)) {
        return this.#connections.get(reg.connectionId);
      }
    }

    return undefined;
  }

  listActiveSessions(): Array<{
    route: RouteKey;
    projectLabel: string;
    sessionLabel: string;
    hostLabel?: string;
  }> {
    const sessions = [];
    for (const registered of this.#routes.values()) {
      sessions.push({
        route: registered.route,
        projectLabel: registered.projectLabel,
        sessionLabel: registered.sessionLabel,
        ...(registered.hostLabel ? { hostLabel: registered.hostLabel } : {}),
      });
    }
    return sessions;
  }
}

export class RouteRegistrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RouteRegistrationError";
  }
}

export function serializeRouteKey(route: RouteKey): string {
  return JSON.stringify([
    route.machineId,
    route.instanceId,
    route.projectId,
    route.sessionId,
    route.routeGeneration,
  ]);
}

function sameSessionRoute(left: RouteKey, right: RouteKey): boolean {
  return (
    left.machineId === right.machineId &&
    left.instanceId === right.instanceId &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId
  );
}
