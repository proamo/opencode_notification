import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  BROKER_CAPABILITIES,
  type BrokerEnvelope,
  type ClientEnvelope,
  ClientEnvelopeSchema,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
} from "../protocol";
import {
  defaultStateDirectory,
  loadOrCreateStateIdentity,
  removeDiscoveryRecord,
  StateDatabase,
  writeDiscoveryRecord,
} from "../state";
import { type BrokerConnectionData, RouteRegistrationError, RouteRegistry } from "./registry";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 42617;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000;

const HealthResponseSchema = z.object({
  service: z.literal("opencode-telegram-link"),
  machineId: z.uuid(),
  protocol: z.object({ major: z.number().int(), minor: z.number().int() }),
});

export type StartBrokerOptions = {
  stateDirectory?: string;
  port?: number;
  registrationTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  idleTimeoutMs?: number;
  maintenanceIntervalMs?: number;
};

export type StartOrReuseBrokerResult =
  | { kind: "started"; broker: BrokerServer }
  | { kind: "existing"; machineId: string; port: number };

export class BrokerServer {
  readonly machineId: string;
  readonly registry: RouteRegistry;
  readonly database: StateDatabase;
  readonly port: number;
  readonly finished: Promise<void>;

  readonly #server: Bun.Server<BrokerConnectionData>;
  readonly #connections = new Set<Bun.ServerWebSocket<BrokerConnectionData>>();
  readonly #livenessTimer: ReturnType<typeof setInterval>;
  readonly #maintenanceTimer: ReturnType<typeof setInterval>;
  readonly #removeDiscovery: () => Promise<void>;
  #resolveFinished!: () => void;
  #stopped = false;

  constructor(input: {
    server: Bun.Server<BrokerConnectionData>;
    machineId: string;
    registry: RouteRegistry;
    database: StateDatabase;
    connections: Set<Bun.ServerWebSocket<BrokerConnectionData>>;
    livenessTimer: ReturnType<typeof setInterval>;
    maintenanceTimer: ReturnType<typeof setInterval>;
    removeDiscovery: () => Promise<void>;
  }) {
    this.#server = input.server;
    this.machineId = input.machineId;
    this.registry = input.registry;
    this.database = input.database;
    this.port = input.server.port ?? DEFAULT_PORT;
    this.#connections = input.connections;
    this.#livenessTimer = input.livenessTimer;
    this.#maintenanceTimer = input.maintenanceTimer;
    this.#removeDiscovery = input.removeDiscovery;
    this.finished = new Promise((resolve) => {
      this.#resolveFinished = resolve;
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    clearInterval(this.#livenessTimer);
    clearInterval(this.#maintenanceTimer);
    await this.#server.stop(true);
    this.#connections.clear();
    await this.#removeDiscovery();
    this.database.close();
    this.#resolveFinished();
  }
}

export async function startBroker(options: StartBrokerOptions = {}): Promise<BrokerServer> {
  const state = await loadOrCreateStateIdentity(options.stateDirectory ?? defaultStateDirectory());
  const registry = new RouteRegistry(state.machineId);
  const database = await StateDatabase.open({
    stateDirectory: state.stateDirectory,
    machineId: state.machineId,
  });
  const connections = new Set<Bun.ServerWebSocket<BrokerConnectionData>>();
  const registrationTimeoutMs = options.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
  let lastNonIdleAt = Date.now();
  let broker: BrokerServer | undefined;

  const server = (() => {
    try {
      return Bun.serve<BrokerConnectionData>({
        hostname: LOOPBACK_HOST,
        port: options.port ?? DEFAULT_PORT,
        fetch(request, bunServer) {
          const url = new URL(request.url);
          if (url.pathname !== "/v1/health" && url.pathname !== "/v1/connect") {
            return new Response("Not found", { status: 404 });
          }
          if (!isAuthorized(request.headers.get("authorization"), state.brokerSecret)) {
            return new Response("Unauthorized", { status: 401 });
          }
          if (url.pathname === "/v1/health") {
            return Response.json({
              service: "opencode-telegram-link",
              machineId: state.machineId,
              protocol: PROTOCOL_VERSION,
            });
          }

          const upgraded = bunServer.upgrade(request, {
            data: {
              connectionId: randomUUID(),
              connectedAt: Date.now(),
              lastHeartbeatAt: Date.now(),
            },
          });
          if (!upgraded) return new Response("WebSocket upgrade required", { status: 426 });
          return undefined;
        },
        websocket: {
          maxPayloadLength: MAX_FRAME_BYTES,
          idleTimeout: Math.max(1, Math.ceil(heartbeatTimeoutMs / 1000)),
          open(socket) {
            connections.add(socket);
          },
          message(socket, message) {
            handleMessage(socket, message, state.machineId, registry);
          },
          close(socket) {
            connections.delete(socket);
            registry.removeConnection(socket.data.connectionId);
          },
        },
      });
    } catch (error) {
      database.close();
      throw error;
    }
  })();

  const livenessTimer = setInterval(
    () => {
      const now = Date.now();
      if (connections.size > 0) lastNonIdleAt = now;
      for (const socket of connections) {
        const timeout = socket.data.instanceId ? heartbeatTimeoutMs : registrationTimeoutMs;
        const reference = socket.data.instanceId
          ? socket.data.lastHeartbeatAt
          : socket.data.connectedAt;
        if (now - reference > timeout) socket.close(1008, "connection timed out");
      }
      if (connections.size === 0 && now - lastNonIdleAt >= idleTimeoutMs) {
        void broker?.stop();
      }
    },
    Math.min(registrationTimeoutMs, heartbeatTimeoutMs, idleTimeoutMs, 1_000),
  );
  livenessTimer.unref();
  try {
    database.cleanup(Date.now());
  } catch (error) {
    clearInterval(livenessTimer);
    await server.stop(true);
    database.close();
    throw error;
  }
  const maintenanceTimer = setInterval(() => {
    try {
      database.cleanup(Date.now());
    } catch {
      process.stderr.write("opencode-telegram-link: state maintenance failed\n");
    }
  }, maintenanceIntervalMs);
  maintenanceTimer.unref();

  try {
    const discovery = await writeDiscoveryRecord(state.stateDirectory, server.port ?? DEFAULT_PORT);
    broker = new BrokerServer({
      server,
      machineId: state.machineId,
      registry,
      database,
      connections,
      livenessTimer,
      maintenanceTimer,
      removeDiscovery: () => removeDiscoveryRecord(state.stateDirectory, discovery.nonce),
    });
    return broker;
  } catch (error) {
    clearInterval(livenessTimer);
    clearInterval(maintenanceTimer);
    await server.stop(true);
    database.close();
    throw error;
  }
}

export async function startOrReuseBroker(
  options: StartBrokerOptions = {},
): Promise<StartOrReuseBrokerResult> {
  try {
    return { kind: "started", broker: await startBroker(options) };
  } catch (error) {
    if (!isAddressInUseError(error)) throw error;
  }

  const stateDirectory = options.stateDirectory ?? defaultStateDirectory();
  const state = await loadOrCreateStateIdentity(stateDirectory);
  const port = options.port ?? DEFAULT_PORT;
  const health = await probeBroker(port, state.brokerSecret);
  if (!health || health.machineId !== state.machineId) {
    throw new BrokerPortConflictError(port);
  }
  return { kind: "existing", machineId: health.machineId, port };
}

export async function probeBroker(
  port: number,
  brokerSecret: string,
): Promise<z.infer<typeof HealthResponseSchema> | undefined> {
  try {
    const response = await fetch(`http://${LOOPBACK_HOST}:${port}/v1/health`, {
      headers: { authorization: `Bearer ${brokerSecret}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    return HealthResponseSchema.parse(await response.json());
  } catch {
    return undefined;
  }
}

export class BrokerPortConflictError extends Error {
  constructor(readonly port: number) {
    super(`port ${port} is occupied by a process that is not the authenticated local broker`);
    this.name = "BrokerPortConflictError";
  }
}

function handleMessage(
  socket: Bun.ServerWebSocket<BrokerConnectionData>,
  message: string | Buffer<ArrayBuffer>,
  machineId: string,
  registry: RouteRegistry,
): void {
  const text = typeof message === "string" ? message : message.toString("utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
    sendError(socket, randomUUID(), "FRAME_TOO_LARGE", "protocol frame is too large");
    socket.close(1009, "frame too large");
    return;
  }

  let envelope: ClientEnvelope;
  try {
    envelope = ClientEnvelopeSchema.parse(JSON.parse(text));
  } catch {
    sendError(socket, randomUUID(), "INVALID_FRAME", "protocol frame is invalid");
    socket.close(1008, "invalid protocol frame");
    return;
  }

  try {
    if (!socket.data.instanceId && envelope.type !== "register") {
      throw new RouteRegistrationError("NOT_REGISTERED", "connection must register first");
    }

    switch (envelope.type) {
      case "register": {
        const missingCapability = BROKER_CAPABILITIES.find(
          (capability) => !envelope.payload.capabilities.includes(capability),
        );
        if (missingCapability) {
          throw new RouteRegistrationError(
            "CAPABILITY_REQUIRED",
            `required capability is missing: ${missingCapability}`,
          );
        }
        registry.registerConnection(
          socket,
          envelope.payload.instanceId,
          envelope.payload.machineId,
        );
        socket.data.lastHeartbeatAt = Date.now();
        send(socket, {
          protocol: PROTOCOL_VERSION,
          type: "registered",
          requestId: envelope.requestId,
          sentAt: new Date().toISOString(),
          payload: {
            machineId,
            capabilities: BROKER_CAPABILITIES.filter((capability) =>
              envelope.payload.capabilities.includes(capability),
            ),
          },
        });
        return;
      }
      case "route.register": {
        registry.registerRoute(socket.data.connectionId, envelope.payload);
        send(socket, responseFor(envelope, "route.registered"));
        return;
      }
      case "route.unregister": {
        if (!registry.unregisterRoute(socket.data.connectionId, envelope.payload.route)) {
          throw new RouteRegistrationError(
            "ROUTE_NOT_OWNED",
            "route is not owned by this connection",
          );
        }
        send(socket, responseFor(envelope, "route.unregistered"));
        return;
      }
      case "heartbeat": {
        socket.data.lastHeartbeatAt = Date.now();
        send(socket, {
          protocol: PROTOCOL_VERSION,
          type: "heartbeat.ack",
          requestId: envelope.requestId,
          sentAt: new Date().toISOString(),
          payload: {},
        });
        return;
      }
    }
  } catch (error) {
    const code = error instanceof RouteRegistrationError ? error.code : "REQUEST_REJECTED";
    const messageText =
      error instanceof RouteRegistrationError ? error.message : "protocol request was rejected";
    sendError(socket, envelope.requestId, code, messageText);
    if (envelope.type === "register") setTimeout(() => socket.terminate(), 0);
  }
}

function responseFor(
  envelope: Extract<ClientEnvelope, { type: "route.register" | "route.unregister" }>,
  type: "route.registered" | "route.unregistered",
): BrokerEnvelope {
  return {
    protocol: PROTOCOL_VERSION,
    type,
    requestId: envelope.requestId,
    sentAt: new Date().toISOString(),
    payload: { route: envelope.payload.route },
  };
}

function send(socket: Bun.ServerWebSocket<BrokerConnectionData>, envelope: BrokerEnvelope): void {
  socket.send(JSON.stringify(envelope));
}

function sendError(
  socket: Bun.ServerWebSocket<BrokerConnectionData>,
  requestId: string,
  code: string,
  message: string,
): void {
  send(socket, {
    protocol: PROTOCOL_VERSION,
    type: "error",
    requestId,
    sentAt: new Date().toISOString(),
    payload: { code, message },
  });
}

function isAuthorized(authorization: string | null, brokerSecret: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = createHash("sha256").update(authorization.slice(7)).digest();
  const expected = createHash("sha256").update(brokerSecret).digest();
  return timingSafeEqual(supplied, expected);
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
