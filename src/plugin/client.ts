import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackGatewayHost, isPrivateGatewayHost, parseGatewayWebSocketUrl } from "../network";
import {
  BROKER_CAPABILITIES,
  type BrokerCommand,
  type BrokerEnvelope,
  BrokerEnvelopeSchema,
  type ClientEnvelope,
  ClientEnvelopeSchema,
  type CommandResult,
  type NormalizedNotification,
  PROTOCOL_VERSION,
  type RouteKey,
  type TelegramRuntimeConfig,
} from "../protocol";
import {
  createRouteKey,
  defaultStateDirectory,
  loadOrCreateStateIdentity,
  type StateIdentity,
} from "../state/identity";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function probeBroker(
  port: number,
  brokerSecret: string,
  host = "127.0.0.1",
): Promise<{ status: "ok"; machineId: string } | undefined> {
  const normalizedHost = normalizeClientHost(host);
  try {
    const response = await fetch(`http://${urlHost(normalizedHost)}:${port}/v1/health`, {
      headers: { authorization: `Bearer ${brokerSecret}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as {
      service?: string;
      status?: string;
      machineId?: string;
    };
    if (
      json &&
      (json.service === "opencode-telegram-link" || json.status === "ok") &&
      typeof json.machineId === "string"
    ) {
      return { status: "ok", machineId: json.machineId };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_PORT = 42617;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_CONFIG_FINGERPRINT = "0".repeat(64);

export type RouteIntent = {
  projectId: string;
  sessionId: string;
  projectLabel: string;
  sessionLabel: string;
  active?: boolean;
};

export type BrokerClientOptions = {
  stateDirectory?: string;
  host?: string;
  port?: number;
  hostLabel?: string | undefined;
  projectLabel?: string | undefined;
  gatewayUrl?: string | undefined;
  gatewaySecret?: string | undefined;
  instanceId?: string;
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
    host: string;
    port: number;
  }) => void | Promise<void>;
  random?: () => number;
  onCommand?: (command: BrokerCommand) => CommandResult | Promise<CommandResult>;
  onDiagnostic?: (code: string, message: string) => void;
  telegram?: TelegramRuntimeConfig;
};

type PendingRequest = {
  resolve: (envelope: BrokerEnvelope) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

class ManagedBrokerUnavailableError extends Error {
  constructor() {
    super("managed private Broker is not reachable");
    this.name = "ManagedBrokerUnavailableError";
  }
}

export class BrokerClient {
  readonly instanceId: string;

  readonly #options: Required<
    Pick<
      BrokerClientOptions,
      | "packageVersion"
      | "openCodeVersion"
      | "startupTimeoutMs"
      | "requestTimeoutMs"
      | "heartbeatIntervalMs"
      | "reconnectMinDelayMs"
      | "reconnectMaxDelayMs"
      | "configFingerprint"
      | "random"
      | "onCommand"
      | "onDiagnostic"
    >
  > & {
    stateDirectory: string;
    host: string;
    spawnHost: string;
    port: number;
    hostLabel: string | undefined;
    projectLabel: string | undefined;
    gatewayUrl: string | undefined;
    gatewaySecret: string | undefined;
    spawnBroker: BrokerClientOptions["spawnBroker"] | undefined;
    telegram: TelegramRuntimeConfig | undefined;
  };
  readonly #routes = new Map<string, RouteIntent>();
  readonly #activeRoutes = new Map<string, RouteKey>();
  readonly #pending = new Map<string, PendingRequest>();
  #identity: StateIdentity | undefined;
  #socket: WebSocket | undefined;
  #runPromise: Promise<void> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;
  #connected = false;
  #firstConnection: Promise<void> | undefined;
  #resolveFirstConnection: (() => void) | undefined;
  #rejectFirstConnection: ((error: Error) => void) | undefined;

  constructor(options: BrokerClientOptions) {
    this.instanceId = options.instanceId ?? randomUUID();
    const configuredHost = options.host ?? "127.0.0.1";
    this.#options = {
      stateDirectory: options.stateDirectory ?? defaultStateDirectory(),
      host: normalizeClientHost(configuredHost),
      spawnHost: configuredHost,
      port: options.port ?? DEFAULT_PORT,
      hostLabel: options.hostLabel,
      projectLabel: options.projectLabel,
      gatewayUrl: options.gatewayUrl,
      gatewaySecret: options.gatewaySecret,
      packageVersion: options.packageVersion,
      openCodeVersion: options.openCodeVersion,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      reconnectMinDelayMs: options.reconnectMinDelayMs ?? 100,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 5_000,
      configFingerprint: options.configFingerprint ?? DEFAULT_CONFIG_FINGERPRINT,
      spawnBroker: options.spawnBroker,
      random: options.random ?? Math.random,
      onCommand: options.onCommand ?? rejectUnsupportedCommand,
      onDiagnostic: options.onDiagnostic ?? (() => undefined),
      telegram: options.telegram,
    };
  }

  get connected(): boolean {
    return this.#connected;
  }

  async start(): Promise<void> {
    if (this.#runPromise) return await this.waitUntilConnected();
    this.#stopped = false;
    this.#identity = await loadOrCreateStateIdentity(this.#options.stateDirectory);
    this.#firstConnection = new Promise((resolve, reject) => {
      this.#resolveFirstConnection = resolve;
      this.#rejectFirstConnection = reject;
    });
    this.#runPromise = this.#run();

    try {
      await Promise.race([
        this.#firstConnection,
        sleep(this.#options.startupTimeoutMs).then(() => {
          throw new Error("timed out waiting for the local broker");
        }),
      ]);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearHeartbeat();
    closeSocket(this.#socket);
    if (this.#connected) this.#dropPending();
    else this.#rejectPending(new Error("broker client stopped"));
    const runPromise = this.#runPromise;
    if (runPromise) await runPromise.catch(() => undefined);
    this.#runPromise = undefined;
    this.#connected = false;
  }

  async waitUntilConnected(timeoutMs = this.#options.startupTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#connected) {
      if (this.#stopped || Date.now() >= deadline) {
        throw new Error("broker client is not connected");
      }
      await sleep(10);
    }
  }

  async upsertRoute(intent: RouteIntent): Promise<RouteKey | undefined> {
    const key = routeIntentKey(intent);
    this.#routes.set(key, intent);
    if (!this.#connected) return undefined;
    return await this.#registerRoute(key, intent);
  }

  async removeRoute(projectId: string, sessionId: string): Promise<void> {
    const key = routeIntentKey({ projectId, sessionId });
    this.#routes.delete(key);
    const route = this.#activeRoutes.get(key);
    this.#activeRoutes.delete(key);
    if (route && this.#socket?.readyState === WebSocket.OPEN) {
      await this.#request({ type: "route.unregister", payload: { route } });
    }
  }

  async setRouteActivity(projectId: string, sessionId: string, active: boolean): Promise<boolean> {
    const key = routeIntentKey({ projectId, sessionId });
    const intent = this.#routes.get(key);
    const route = this.#activeRoutes.get(key);
    if (!intent || !route) return false;
    if (intent.active === active) return true;
    this.#routes.set(key, { ...intent, active });
    const response = await this.#request({
      type: "route.register",
      payload: {
        route,
        ...(this.#options.hostLabel ? { hostLabel: this.#options.hostLabel } : {}),
        projectLabel: intent.projectLabel,
        sessionLabel: intent.sessionLabel,
        active,
      },
    });
    return response.type === "route.registered";
  }

  activeRoute(projectId: string, sessionId: string): RouteKey | undefined {
    return this.#activeRoutes.get(routeIntentKey({ projectId, sessionId }));
  }

  async publishNotification(notification: NormalizedNotification): Promise<"queued" | "duplicate"> {
    const response = await this.#request({
      type: "notification.publish",
      payload: { notification },
    });
    if (response.type !== "notification.published") {
      throw new Error("notification publish was rejected");
    }
    return response.payload.status;
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#stopped) {
      try {
        await this.#ensureBroker();
        await this.#connectAndServe();
        attempt = 0;
      } catch (error) {
        if (this.#stopped) break;
        const message = error instanceof Error ? error.message : "unknown broker client error";
        this.#options.onDiagnostic("BROKER_RECONNECT", message);
        if (this.#rejectFirstConnection && !(error instanceof ManagedBrokerUnavailableError)) {
          const reject = this.#rejectFirstConnection;
          this.#resolveFirstConnection = undefined;
          this.#rejectFirstConnection = undefined;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        const maximum = Math.min(
          this.#options.reconnectMaxDelayMs,
          this.#options.reconnectMinDelayMs * 2 ** attempt,
        );
        attempt += 1;
        await sleep(Math.floor(maximum * this.#options.random()));
      }
    }
  }

  async #ensureBroker(): Promise<void> {
    if (this.#options.gatewayUrl) return;
    const identity = this.#requireIdentity();
    if (await probeBroker(this.#options.port, identity.brokerSecret, this.#options.host)) return;
    const persisted = await readNativeDeploymentEndpoint(identity.stateDirectory);
    if (
      persisted &&
      persisted.port === this.#options.port &&
      persisted.host !== this.#options.host &&
      isLoopbackGatewayHost(this.#options.host) &&
      (await probeBroker(persisted.port, identity.brokerSecret, persisted.host))
    ) {
      this.#options.onDiagnostic(
        "BROKER_HOST_FROM_DEPLOYMENT",
        `configured Gateway host ${this.#options.host} is unreachable; using the native deployment endpoint ${persisted.host}`,
      );
      this.#options.host = persisted.host;
      return;
    }
    if (!isLoopbackGatewayHost(normalizeClientHost(this.#options.host))) {
      throw new ManagedBrokerUnavailableError();
    }

    await (this.#options.spawnBroker ?? spawnDetachedBroker)({
      stateDirectory: identity.stateDirectory,
      host: this.#options.spawnHost,
      port: this.#options.port,
    });

    const deadline = Date.now() + this.#options.startupTimeoutMs;
    while (!this.#stopped && Date.now() < deadline) {
      if (await probeBroker(this.#options.port, identity.brokerSecret, this.#options.host)) return;
      await sleep(25);
    }
    throw new Error("spawned broker did not become healthy");
  }

  async #connectAndServe(): Promise<void> {
    const identity = this.#requireIdentity();
    let url: string;
    if (this.#options.gatewayUrl) {
      url = parseGatewayWebSocketUrl(this.#options.gatewayUrl).toString();
    } else {
      url = `ws://${urlHost(this.#options.host)}:${this.#options.port}/v1/connect`;
    }

    const connectionSecret = this.#options.gatewayUrl
      ? this.#options.gatewaySecret
      : identity.gatewaySecret;
    const socket = new WebSocket(url, {
      headers: {
        ...(connectionSecret ? { authorization: `Bearer ${connectionSecret}` } : {}),
        ...(!this.#options.gatewayUrl
          ? { "x-opencode-telegram-admin": `Bearer ${identity.brokerSecret}` }
          : {}),
      },
    });
    try {
      await waitForOpen(socket, this.#options.requestTimeoutMs);
    } catch (error) {
      closeSocket(socket);
      throw error;
    }
    this.#socket = socket;

    const disconnected = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) =>
        this.#handleMessage(decodeMessageData(event.data)),
      );
      socket.addEventListener("close", () => resolve(), { once: true });
      socket.addEventListener("error", () => resolve(), { once: true });
    });

    try {
      const registered = await this.#request({
        type: "register",
        payload: {
          packageVersion: this.#options.packageVersion,
          openCodeVersion: this.#options.openCodeVersion,
          machineId: identity.machineId,
          instanceId: this.instanceId,
          ...(this.#options.hostLabel ? { hostLabel: this.#options.hostLabel } : {}),
          ...(this.#options.projectLabel ? { projectLabel: this.#options.projectLabel } : {}),
          configFingerprint: this.#options.configFingerprint,
          capabilities: [...BROKER_CAPABILITIES],
          ...(this.#options.telegram ? { telegram: this.#options.telegram } : {}),
        },
      });
      if (registered.type !== "registered") {
        throw new Error("broker registration was rejected");
      }

      this.#activeRoutes.clear();
      for (const [key, intent] of this.#routes) await this.#registerRoute(key, intent);
      this.#connected = true;
      this.#resolveFirstConnection?.();
      this.#resolveFirstConnection = undefined;
      this.#rejectFirstConnection = undefined;
      this.#startHeartbeat();
      await disconnected;
    } finally {
      this.#connected = false;
      this.#activeRoutes.clear();
      this.#clearHeartbeat();
      this.#rejectPending(new Error("broker connection closed"));
      if (this.#socket === socket) this.#socket = undefined;
      closeSocket(socket);
    }
  }

  async #registerRoute(key: string, intent: RouteIntent): Promise<RouteKey | undefined> {
    const identity = this.#requireIdentity();
    const route = createRouteKey({
      machineId: identity.machineId,
      instanceId: this.instanceId,
      projectId: intent.projectId,
      sessionId: intent.sessionId,
    });
    const response = await this.#request({
      type: "route.register",
      payload: {
        route,
        ...(this.#options.hostLabel ? { hostLabel: this.#options.hostLabel } : {}),
        projectLabel: intent.projectLabel,
        sessionLabel: intent.sessionLabel,
        ...(intent.active !== undefined ? { active: intent.active } : {}),
      },
    });
    if (response.type !== "route.registered") throw new Error("route registration was rejected");
    if (this.#routes.get(key) !== intent) {
      if (this.#socket?.readyState === WebSocket.OPEN) {
        await this.#request({ type: "route.unregister", payload: { route } }).catch(
          () => undefined,
        );
      }
      return undefined;
    }
    this.#activeRoutes.set(key, route);
    return route;
  }

  async #request(input: {
    type: ClientEnvelope["type"];
    payload: unknown;
  }): Promise<BrokerEnvelope> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("broker connection is not open");
    }
    const requestId = randomUUID();
    const envelope = ClientEnvelopeSchema.parse({
      protocol: PROTOCOL_VERSION,
      requestId,
      sentAt: new Date().toISOString(),
      ...input,
    });

    const response = new Promise<BrokerEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`broker request timed out: ${input.type}`));
      }, this.#options.requestTimeoutMs);
      this.#pending.set(requestId, { resolve, reject, timeout });
    });
    response.catch(() => undefined);
    socket.send(JSON.stringify(envelope));
    return await response;
  }

  #handleMessage(text: string): void {
    let envelope: BrokerEnvelope;
    try {
      envelope = BrokerEnvelopeSchema.parse(JSON.parse(text));
    } catch {
      closeSocket(this.#socket);
      return;
    }

    if (envelope.type === "command") {
      void this.#handleCommand(envelope.requestId, envelope.payload);
      return;
    }

    const pending = this.#pending.get(envelope.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(envelope.requestId);
    if (envelope.type === "error") {
      pending.reject(new Error(`${envelope.payload.code}: ${envelope.payload.message}`));
    } else {
      pending.resolve(envelope);
    }
  }

  async #handleCommand(requestId: string, command: BrokerCommand): Promise<void> {
    let result: CommandResult;
    try {
      result = await this.#options.onCommand(command);
    } catch (error) {
      result = {
        commandId: command.commandId,
        status: "indeterminate",
        reason: error instanceof Error ? error.message.slice(0, 256) : "command handler failed",
      };
    }
    this.#send({ type: "command.result", requestId, payload: result });
  }

  #send(input: {
    type: Extract<ClientEnvelope["type"], "command.result">;
    requestId: string;
    payload: CommandResult;
  }): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const envelope = ClientEnvelopeSchema.parse({
      protocol: PROTOCOL_VERSION,
      sentAt: new Date().toISOString(),
      ...input,
    });
    socket.send(JSON.stringify(envelope));
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    let missedHeartbeats = 0;
    this.#heartbeatTimer = setInterval(() => {
      void this.#request({ type: "heartbeat", payload: {} })
        .then(() => {
          missedHeartbeats = 0;
        })
        .catch(() => {
          missedHeartbeats += 1;
          if (missedHeartbeats >= 3) {
            closeSocket(this.#socket);
          }
        });
    }, this.#options.heartbeatIntervalMs);
    this.#heartbeatTimer.unref();
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #rejectPending(error: Error): void {
    for (const request of this.#pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.#pending.clear();
  }

  #dropPending(): void {
    for (const request of this.#pending.values()) clearTimeout(request.timeout);
    this.#pending.clear();
  }

  #requireIdentity(): StateIdentity {
    if (!this.#identity) throw new Error("broker client identity is not initialized");
    return this.#identity;
  }
}

export function derivePluginInstanceId(
  directory: string,
  machineId: string,
  pid = process.pid,
): string {
  const bytes = createHash("sha256")
    .update(`${machineId}\0${pid}\0${realpathSync(directory)}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function spawnDetachedBroker(input: {
  stateDirectory: string;
  host: string;
  port: number;
}): void {
  const brokerEntry = fileURLToPath(new URL("./broker/main.js", import.meta.url));
  const runtime = brokerRuntimeCommand();
  const child = spawn(runtime.command, [...runtime.args, brokerEntry], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OPENCODE_TELEGRAM_BROKER_STATE_DIR: input.stateDirectory,
      OPENCODE_TELEGRAM_BROKER_PORT: String(input.port),
      OPENCODE_TELEGRAM_BROKER_BIND_HOST:
        process.env.OPENCODE_TELEGRAM_BROKER_BIND_HOST ?? input.host,
    },
  });
  child.unref();
}

async function readNativeDeploymentEndpoint(
  stateDirectory: string,
): Promise<{ host: string; port: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(join(stateDirectory, "deployment.json"), "utf8")) as {
      mode?: unknown;
      bindHost?: unknown;
      port?: unknown;
    };
    if (value.mode !== "native" || typeof value.bindHost !== "string") return undefined;
    if (typeof value.port !== "number" || !Number.isInteger(value.port)) return undefined;
    return { host: normalizeClientHost(value.bindHost), port: value.port };
  } catch {
    return undefined;
  }
}

function normalizeClientHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  if (!isPrivateGatewayHost(host)) {
    throw new Error("local broker host must be loopback or a private IP address");
  }
  return host;
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export function brokerRuntimeCommand(): { command: string; args: string[] } {
  if (process.versions.bun && basename(process.execPath).startsWith("bun")) {
    return { command: process.execPath, args: [] };
  }
  if (process.env.OPENCODE_TELEGRAM_BUN) {
    return { command: process.env.OPENCODE_TELEGRAM_BUN, args: [] };
  }
  const home = homedir();
  const candidateBunPaths = [
    join(home, ".bun", "bin", "bun"),
    join(home, ".local", "bin", "bun"),
    "/usr/local/bin/bun",
    "/usr/bin/bun",
  ];
  for (const candidate of candidateBunPaths) {
    try {
      if (existsSync(candidate)) {
        return { command: candidate, args: [] };
      }
    } catch {}
  }
  return { command: "npx", args: ["--yes", "bun"] };
}

function routeIntentKey(input: Pick<RouteIntent, "projectId" | "sessionId">): string {
  return JSON.stringify([input.projectId, input.sessionId]);
}

function rejectUnsupportedCommand(command: BrokerCommand): CommandResult {
  return { commandId: command.commandId, status: "rejected", reason: "unsupported command" };
}

async function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("broker WebSocket open timed out")),
      timeoutMs,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("broker WebSocket connection failed"));
      },
      { once: true },
    );
  });
}

function closeSocket(socket?: WebSocket | null): void {
  if (!socket) return;
  try {
    const terminable = socket as unknown as { terminate?: () => void };
    if (typeof terminable.terminate === "function") {
      terminable.terminate();
    } else if (typeof socket.close === "function") {
      socket.close();
    }
  } catch {}
}

function decodeMessageData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer);
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return String(data);
}
