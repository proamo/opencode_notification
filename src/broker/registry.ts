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
  projectLabel: string;
  sessionLabel: string;
  connectionId: string;
};

type OwnedConnection = {
  socket: ServerWebSocket<BrokerConnectionData>;
  instanceId: string;
  routeKeys: Set<string>;
};

export class RouteRegistry {
  readonly #machineId: string;
  readonly #connections = new Map<string, OwnedConnection>();
  readonly #instances = new Map<string, string>();
  readonly #routes = new Map<string, RegisteredRoute>();

  constructor(machineId: string) {
    this.#machineId = machineId;
  }

  registerConnection(
    socket: ServerWebSocket<BrokerConnectionData>,
    instanceId: string,
    machineId: string,
  ): void {
    if (machineId !== this.#machineId) {
      throw new RouteRegistrationError("MACHINE_MISMATCH", "route belongs to another machine");
    }

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
      routeKeys: existing?.routeKeys ?? new Set(),
    });
    this.#instances.set(instanceId, socket.data.connectionId);
    socket.data.instanceId = instanceId;
  }

  registerRoute(
    connectionId: string,
    input: { route: RouteKey; projectLabel: string; sessionLabel: string },
  ): RegisteredRoute {
    const connection = this.#connections.get(connectionId);
    if (!connection) {
      throw new RouteRegistrationError("NOT_REGISTERED", "connection must register first");
    }

    const route = RouteKeySchema.parse(input.route);
    if (route.machineId !== this.#machineId) {
      throw new RouteRegistrationError("MACHINE_MISMATCH", "route belongs to another machine");
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

    const registered = { ...input, route, connectionId };
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

    // Hot fallback: match by (machineId, projectId, sessionId) across active registered routes
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

  owner(route: RouteKey): ServerWebSocket<BrokerConnectionData> | undefined {
    const registered = this.resolve(route);
    if (!registered) return undefined;
    return this.#connections.get(registered.connectionId)?.socket;
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
