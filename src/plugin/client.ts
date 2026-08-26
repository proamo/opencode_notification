import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
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
): Promise<{ status: "ok"; machineId: string } | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
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
  spawnBroker?: (input: { stateDirectory: string; port: number }) => void | Promise<void>;
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

export class BrokerClient {
  readonly instanceId = randomUUID();

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
    port: number;
    hostLabel: string | undefined;
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
    this.#options = {
      stateDirectory: options.stateDirectory ?? defaultStateDirectory(),
      port: options.port ?? DEFAULT_PORT,
      hostLabel: options.hostLabel,
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
    if (route && this.#connected) {
      await this.#request({ type: "route.unregister", payload: { route } });
    }
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
        if (this.#rejectFirstConnection) {
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
    if (await probeBroker(this.#options.port, identity.brokerSecret)) return;

    await (this.#options.spawnBroker ?? spawnDetachedBroker)({
      stateDirectory: identity.stateDirectory,
      port: this.#options.port,
    });

    const deadline = Date.now() + this.#options.startupTimeoutMs;
    while (!this.#stopped && Date.now() < deadline) {
      if (await probeBroker(this.#options.port, identity.brokerSecret)) return;
      await sleep(25);
    }
    throw new Error("spawned broker did not become healthy");
  }

  async #connectAndServe(): Promise<void> {
    const identity = this.#requireIdentity();
    let url: string;
    if (this.#options.gatewayUrl) {
      const base = this.#options.gatewayUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
      const parsedUrl = new URL(base.includes("://") ? base : `ws://${base}`);
      if (!parsedUrl.pathname || parsedUrl.pathname === "/") {
        parsedUrl.pathname = "/v1/connect";
      }
      if (this.#options.gatewaySecret) {
        parsedUrl.searchParams.set("token", this.#options.gatewaySecret);
      }
      url = parsedUrl.toString();
    } else {
      url = `ws://127.0.0.1:${this.#options.port}/v1/connect?token=${encodeURIComponent(identity.brokerSecret)}`;
    }

    const socket = new WebSocket(url);
    try {
      await waitForOpen(socket, this.#options.requestTimeoutMs);
    } catch (error) {
      closeSocket(socket);
      throw error;
    }
    this.#socket = socket;

    const disconnected = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => this.#handleMessage(String(event.data)));
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

  async #registerRoute(key: string, intent: RouteIntent): Promise<RouteKey> {
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
      },
    });
    if (response.type !== "route.registered") throw new Error("route registration was rejected");
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
    this.#heartbeatTimer = setInterval(() => {
      void this.#request({ type: "heartbeat", payload: {} }).catch(() => {
        closeSocket(this.#socket);
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

export function spawnDetachedBroker(input: { stateDirectory: string; port: number }): void {
  const brokerEntry = fileURLToPath(new URL("./broker/main.js", import.meta.url));
  const runtime = brokerRuntimeCommand();
  const child = spawn(runtime.command, [...runtime.args, brokerEntry], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OPENCODE_TELEGRAM_BROKER_STATE_DIR: input.stateDirectory,
      OPENCODE_TELEGRAM_BROKER_PORT: String(input.port),
      OPENCODE_TELEGRAM_BROKER_BIND_HOST: "0.0.0.0",
    },
  });
  child.unref();
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
    join(home, ".nvm", "versions", "node", "v24.18.0", "bin", "bun"),
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
