import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type SupportedLocale, translate } from "../i18n";
import {
  BROKER_CAPABILITIES,
  type BrokerCommand,
  type BrokerEnvelope,
  type ClientEnvelope,
  ClientEnvelopeSchema,
  type CommandResult,
  MAX_FRAME_BYTES,
  type NormalizedNotification,
  PROTOCOL_VERSION,
  type TelegramRuntimeConfig,
} from "../protocol";
import {
  defaultStateDirectory,
  loadOrCreateStateIdentity,
  removeDiscoveryRecord,
  StateDatabase,
  writeDiscoveryRecord,
} from "../state";
import {
  createValidatedInteractionHandler,
  executeSlashCommand,
  interactionFeedbackText,
  isSlashCommand,
  renderTelegramNotification,
  submitTelegramInteraction,
  TelegramBotApi,
  type TelegramOutboxPayload,
  TelegramOutboxWorker,
  TelegramPoller,
  type TelegramUpdate,
  TelegramUpdateAuthorizer,
  type UpdateDisposition,
  VoiceTranscriber,
} from "../telegram";
import { renderDashboardHtml } from "./dashboard-html";
import { type BrokerConnectionData, RouteRegistrationError, RouteRegistry } from "./registry";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_BIND_HOST = "0.0.0.0";
const CONTAINER_HOST = "0.0.0.0";
const DEFAULT_PORT = 42617;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_TELEGRAM_DELIVERY_INTERVAL_MS = 2_000;
const NOTIFICATION_DEDUPE_TTL_MS = 7 * 24 * 60 * 60_000;

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

  // Backward compatibility
  voiceProvider?: "groq" | "openai" | "cloudflare" | "custom" | undefined;
  voiceApiKey?: string | undefined;
  voiceAccountId?: string | undefined;
  voiceEndpoint?: string | undefined;
  voiceModel?: string | undefined;
};

function normalizeSettings(s: DashboardSettings): DashboardSettings {
  const activeProvider = s.activeProvider ?? s.voiceProvider ?? "cloudflare";
  const cfAccountId =
    s.cloudflare?.accountId ??
    s.voiceAccountId ??
    process.env.CLOUDFLARE_ACCOUNT_ID ??
    process.env.CF_ACCOUNT_ID ??
    "";
  const cfApiToken =
    s.cloudflare?.apiToken ??
    (s.voiceProvider === "cloudflare" ? s.voiceApiKey : undefined) ??
    process.env.CLOUDFLARE_API_TOKEN ??
    process.env.CF_API_TOKEN ??
    "";
  const groqKey =
    s.groq?.apiKey ??
    (s.voiceProvider === "groq" ? s.voiceApiKey : undefined) ??
    process.env.GROQ_API_KEY ??
    "";
  const openaiKey =
    s.openai?.apiKey ??
    (s.voiceProvider === "openai" ? s.voiceApiKey : undefined) ??
    process.env.OPENAI_API_KEY ??
    "";
  const customEndpoint = s.custom?.endpoint ?? s.voiceEndpoint ?? "";
  const customKey =
    s.custom?.apiKey ?? (s.voiceProvider === "custom" ? s.voiceApiKey : undefined) ?? "";
  const customModel = s.custom?.model ?? s.voiceModel ?? "whisper-large-v3-turbo";

  return {
    activeProvider,
    cloudflare: { accountId: cfAccountId, apiToken: cfApiToken },
    groq: { apiKey: groqKey },
    openai: { apiKey: openaiKey },
    custom: { endpoint: customEndpoint, apiKey: customKey, model: customModel },
    sessionPromptTtlMinutes: s.sessionPromptTtlMinutes ?? 43200,
  };
}

async function loadDashboardSettings(stateDirectory: string): Promise<DashboardSettings> {
  const filePath = join(stateDirectory, "dashboard-settings.json");
  try {
    const raw = await readFile(filePath, "utf-8");
    return normalizeSettings(JSON.parse(raw) as DashboardSettings);
  } catch {
    return normalizeSettings({});
  }
}

async function saveDashboardSettings(
  stateDirectory: string,
  settings: DashboardSettings,
): Promise<void> {
  const filePath = join(stateDirectory, "dashboard-settings.json");
  await writeFile(filePath, JSON.stringify(settings, null, 2), "utf-8");
}

async function readJsonBody<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text || !text.trim()) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

const HealthResponseSchema = z.object({
  service: z.literal("opencode-telegram-link"),
  machineId: z.uuid(),
  protocol: z.object({ major: z.number().int(), minor: z.number().int() }),
});

const BrokerStatusSchema = HealthResponseSchema.extend({
  bindHost: z.enum([LOOPBACK_HOST, CONTAINER_HOST]),
  connections: z.number().int().nonnegative(),
  routes: z.number().int().nonnegative(),
});

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
  readonly #pendingCommands: Map<string, PendingBrokerCommand>;
  readonly #livenessTimer: ReturnType<typeof setInterval>;
  readonly #maintenanceTimer: ReturnType<typeof setInterval>;
  readonly #removeDiscovery: () => Promise<void>;
  #resolveFinished!: () => void;
  readonly #telegramRuntimeRef: { value: BrokerTelegramRuntime | undefined };
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
    pendingCommands: Map<string, PendingBrokerCommand>;
    telegramRuntimeRef: { value: BrokerTelegramRuntime | undefined };
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
    this.#pendingCommands = input.pendingCommands;
    this.#telegramRuntimeRef = input.telegramRuntimeRef;
    this.finished = new Promise((resolve) => {
      this.#resolveFinished = resolve;
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    clearInterval(this.#livenessTimer);
    clearInterval(this.#maintenanceTimer);
    failPendingCommands(this.#pendingCommands, "broker stopped");
    await this.#telegramRuntimeRef.value?.stop();
    await this.#server.stop(true);
    this.#connections.clear();
    await this.#removeDiscovery();
    this.database.close();
    this.#resolveFinished();
  }

  async sendCommand(
    command: BrokerCommand,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<CommandResult> {
    let socket: Bun.ServerWebSocket<BrokerConnectionData> | undefined;
    let payloadCommand = { ...command };

    if (command.type === "session.spawn") {
      if (command.instanceId) {
        socket = this.registry.ownerByInstance(command.instanceId);
      }
      if (!socket) {
        return {
          commandId: command.commandId,
          status: "stale",
          reason: "target instance is offline",
        };
      }
    } else {
      const registered = this.registry.resolve(command.route);
      socket = registered ? this.registry.owner(registered.route) : undefined;
      if (!registered || !socket) {
        return { commandId: command.commandId, status: "stale", reason: "route is offline" };
      }
      payloadCommand = {
        ...command,
        route: registered.route,
      };
    }

    const requestId = randomUUID();
    const result = new Promise<CommandResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.#pendingCommands.delete(requestId);
        resolve({
          commandId: command.commandId,
          status: "indeterminate",
          reason: "command timed out",
        });
      }, timeoutMs);
      timeout.unref();
      this.#pendingCommands.set(requestId, {
        connectionId: socket.data.connectionId,
        commandId: command.commandId,
        resolve,
        timeout,
      });
    });
    send(socket, {
      protocol: PROTOCOL_VERSION,
      type: "command",
      requestId,
      sentAt: new Date().toISOString(),
      payload: payloadCommand,
    });
    return await result;
  }
}

export async function startBroker(options: StartBrokerOptions = {}): Promise<BrokerServer> {
  const state = await loadOrCreateStateIdentity(options.stateDirectory ?? defaultStateDirectory());
  const registry = new RouteRegistry();
  const database = await StateDatabase.open({
    stateDirectory: state.stateDirectory,
    machineId: state.machineId,
  });
  const connections = new Set<Bun.ServerWebSocket<BrokerConnectionData>>();
  const pendingCommands = new Map<string, PendingBrokerCommand>();
  const activeConfigFingerprint: { value: string | undefined } = { value: undefined };
  const registrationTimeoutMs = options.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
  const deliveryIntervalMs =
    options.telegramDeliveryIntervalMs ?? DEFAULT_TELEGRAM_DELIVERY_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let lastNonIdleAt = Date.now();
  const startedAt = Date.now();
  let broker: BrokerServer | undefined;
  const telegramRuntimeRef: { value: BrokerTelegramRuntime | undefined } = { value: undefined };
  const bindHost = options.bindHost ?? DEFAULT_BIND_HOST;
  let persistedSettings = await loadDashboardSettings(state.stateDirectory);

  const dispatcher = {
    sendCommand: async (command: BrokerCommand): Promise<CommandResult> => {
      if (!broker) {
        return { commandId: command.commandId, status: "stale", reason: "broker is starting" };
      }
      return await broker.sendCommand(command);
    },
  };

  const ensureTelegramRuntime = (config: TelegramRuntimeConfig): BrokerTelegramRuntime => {
    telegramRuntimeRef.value ??= new BrokerTelegramRuntime({
      config,
      database,
      registry,
      dispatcher,
      api: (options.telegramApiFactory ?? ((botToken) => new TelegramBotApi({ token: botToken })))(
        config.botToken,
      ),
      deliveryIntervalMs,
      ...(options.telegramPollLongPollSeconds !== undefined
        ? { pollLongPollSeconds: options.telegramPollLongPollSeconds }
        : {}),
      now,
    });
    telegramRuntimeRef.value.start();
    return telegramRuntimeRef.value;
  };

  const server = (() => {
    try {
      return Bun.serve<BrokerConnectionData>({
        hostname: bindHost,
        port: options.port ?? DEFAULT_PORT,
        fetch(request, bunServer) {
          const url = new URL(request.url);

          // Web Dashboard endpoints
          if (url.pathname === "/" || url.pathname === "/dashboard") {
            return new Response(renderDashboardHtml(), {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }

          if (url.pathname === "/v1/api/dashboard/summary") {
            const machines = registry.listMachines();
            const activeSessions = registry.listActiveSessions();
            const uptimeMs = Date.now() - startedAt;
            const uptimeMinutes = Math.floor(uptimeMs / 60000);
            const uptimeHours = Math.floor(uptimeMinutes / 60);
            const uptimeFormatted =
              uptimeHours > 0 ? `${uptimeHours}h ${uptimeMinutes % 60}m` : `${uptimeMinutes}m`;

            const normalized = normalizeSettings(persistedSettings);
            let activeKey: string | undefined;
            if (normalized.activeProvider === "cloudflare") {
              activeKey = normalized.cloudflare?.apiToken;
            } else if (normalized.activeProvider === "groq") {
              activeKey = normalized.groq?.apiKey;
            } else if (normalized.activeProvider === "openai") {
              activeKey = normalized.openai?.apiKey;
            } else if (normalized.activeProvider === "custom") {
              activeKey = normalized.custom?.apiKey || "custom";
            }

            return Response.json({
              service: "opencode-telegram-link",
              version: "3.0.0",
              machineId: state.machineId,
              protocol: PROTOCOL_VERSION,
              uptimeMs,
              uptimeFormatted,
              connectionsCount: registry.connectionCount,
              routeCount: registry.routeCount,
              machines,
              activeSessions,
              voice: {
                provider: activeKey ? normalized.activeProvider : "none",
                activeProvider: normalized.activeProvider ?? "cloudflare",
                hasApiKey: Boolean(activeKey),
                cloudflare: normalized.cloudflare,
                groq: normalized.groq,
                openai: normalized.openai,
                custom: normalized.custom,
              },
            });
          }

          if (url.pathname === "/v1/api/dashboard/test-voice") {
            if (request.method !== "POST") {
              return new Response("Method not allowed", { status: 405 });
            }
            return (async () => {
              try {
                const body = await readJsonBody<{
                  provider: "groq" | "openai" | "cloudflare" | "custom";
                  apiKey?: string;
                  accountId?: string;
                  endpoint?: string;
                  model?: string;
                }>(request);

                const apiKey =
                  body.apiKey?.trim() ||
                  (body.provider === "groq"
                    ? process.env.GROQ_API_KEY
                    : body.provider === "cloudflare"
                      ? (process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN)
                      : body.provider === "openai"
                        ? process.env.OPENAI_API_KEY
                        : undefined);

                if (!apiKey) {
                  return Response.json(
                    { success: false, error: "請填寫 API 金鑰 / Token" },
                    { status: 400 },
                  );
                }

                if (body.provider === "cloudflare") {
                  const accountId =
                    body.accountId?.trim() ||
                    process.env.CLOUDFLARE_ACCOUNT_ID ||
                    process.env.CF_ACCOUNT_ID;
                  if (!accountId) {
                    return Response.json(
                      { success: false, error: "Cloudflare 必須提供 Account ID" },
                      { status: 400 },
                    );
                  }
                }

                const transcriber = new VoiceTranscriber({
                  apiKey,
                  ...(body.accountId ? { accountId: body.accountId.trim() } : {}),
                  provider: body.provider,
                  ...(body.endpoint ? { endpoint: body.endpoint.trim() } : {}),
                  ...(body.model ? { model: body.model.trim() } : {}),
                });

                // Generate 1-second 16kHz test PCM WAV
                const sampleRate = 16000;
                const numSamples = sampleRate;
                const buffer = new Uint8Array(44 + numSamples * 2);
                const view = new DataView(buffer.buffer);
                buffer.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
                view.setUint32(4, 36 + numSamples * 2, true);
                buffer.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
                buffer.set([0x66, 0x6d, 0x74, 0x20], 12); // fmt
                view.setUint32(16, 16, true);
                view.setUint16(20, 1, true);
                view.setUint16(22, 1, true);
                view.setUint32(24, sampleRate, true);
                view.setUint32(28, sampleRate * 2, true);
                view.setUint16(32, 2, true);
                view.setUint16(34, 16, true);
                buffer.set([0x64, 0x61, 0x74, 0x61], 36); // data
                view.setUint32(40, numSamples * 2, true);
                for (let i = 0; i < numSamples; i++) {
                  const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5 * 32767;
                  view.setInt16(44 + i * 2, Math.floor(sample), true);
                }

                const start = performance.now();
                const text = await transcriber.transcribe(buffer, {
                  mimeType: "audio/wav",
                  fileName: "test.wav",
                });
                const latencyMs = Math.round(performance.now() - start);

                return Response.json({
                  success: true,
                  latencyMs,
                  text: text || "(測試連線成功)",
                  message: `連線驗證成功 (延遲: ${latencyMs}ms)`,
                });
              } catch (err) {
                return Response.json(
                  {
                    success: false,
                    error: err instanceof Error ? err.message : "連線驗證失敗",
                  },
                  { status: 400 },
                );
              }
            })();
          }

          if (url.pathname === "/v1/api/dashboard/dispatch") {
            if (request.method !== "POST") {
              return new Response("Method not allowed", { status: 405 });
            }
            return (async () => {
              try {
                const body = await readJsonBody<{
                  target?: string;
                  prompt: string;
                  sessionId?: string;
                }>(request);
                if (!body.prompt?.trim()) {
                  return Response.json(
                    { success: false, reason: "Prompt is required" },
                    { status: 400 },
                  );
                }

                const prompt = body.prompt.trim();
                const target = body.target?.trim();
                const sessionId = body.sessionId?.trim();

                if (sessionId) {
                  const route = registry.resolveBySessionId(sessionId);
                  if (!route) {
                    return Response.json(
                      { success: false, reason: `Session ${sessionId} not found or offline` },
                      { status: 404 },
                    );
                  }
                  const result = await dispatcher.sendCommand({
                    commandId: randomUUID(),
                    type: "session.prompt",
                    route,
                    text: prompt,
                  });
                  return Response.json({ success: result.status === "accepted", result });
                }

                const machines = registry.listMachines();
                const allProjects: {
                  machineId: string;
                  projectLabel: string;
                  hostLabel?: string | undefined;
                  sessionId?: string | undefined;
                }[] = [];
                for (const m of machines) {
                  for (const p of m.projects) {
                    allProjects.push({
                      machineId: m.machineId,
                      projectLabel: p.projectLabel,
                      ...(m.hostLabel ? { hostLabel: m.hostLabel } : {}),
                      ...(p.sessionId ? { sessionId: p.sessionId } : {}),
                    });
                  }
                }

                const selected = target
                  ? allProjects.find(
                      (p) =>
                        p.projectLabel.toLowerCase() === target.toLowerCase() ||
                        p.hostLabel?.toLowerCase() === target.toLowerCase(),
                    )
                  : allProjects.length === 1
                    ? allProjects[0]
                    : undefined;

                if (!selected) {
                  return Response.json(
                    {
                      success: false,
                      reason: target
                        ? `Target project "${target}" not found`
                        : "Multiple projects online, please specify target project",
                    },
                    { status: 400 },
                  );
                }

                const result = await dispatcher.sendCommand({
                  commandId: randomUUID(),
                  type: "session.spawn",
                  title: prompt.slice(0, 30),
                  prompt,
                });

                return Response.json({ success: result.status === "accepted", result });
              } catch (err) {
                return Response.json(
                  { success: false, reason: (err as Error).message },
                  { status: 500 },
                );
              }
            })();
          }

          if (url.pathname === "/v1/api/dashboard/cancel") {
            if (request.method !== "POST") {
              return new Response("Method not allowed", { status: 405 });
            }
            return (async () => {
              try {
                const body = await readJsonBody<{ sessionId: string }>(request);
                if (!body.sessionId?.trim()) {
                  return Response.json(
                    { success: false, reason: "Session ID is required" },
                    { status: 400 },
                  );
                }
                const route = registry.resolveBySessionId(body.sessionId.trim());
                if (!route) {
                  return Response.json(
                    { success: false, reason: "Session not found or offline" },
                    { status: 404 },
                  );
                }
                const result = await dispatcher.sendCommand({
                  commandId: randomUUID(),
                  type: "session.cancel",
                  route,
                });
                return Response.json({ success: result.status === "accepted", result });
              } catch (err) {
                return Response.json(
                  { success: false, reason: (err as Error).message },
                  { status: 500 },
                );
              }
            })();
          }

          if (url.pathname === "/v1/api/dashboard/settings") {
            if (request.method !== "POST") {
              return new Response("Method not allowed", { status: 405 });
            }
            return (async () => {
              try {
                const body = await readJsonBody<DashboardSettings>(request);
                persistedSettings = normalizeSettings({
                  ...persistedSettings,
                  activeProvider:
                    body.activeProvider ?? body.voiceProvider ?? persistedSettings.activeProvider,
                  cloudflare: {
                    ...persistedSettings.cloudflare,
                    ...(body.cloudflare || {}),
                    ...(body.voiceAccountId ? { accountId: body.voiceAccountId } : {}),
                    ...(body.voiceProvider === "cloudflare" && body.voiceApiKey
                      ? { apiToken: body.voiceApiKey }
                      : {}),
                  },
                  groq: {
                    ...persistedSettings.groq,
                    ...(body.groq || {}),
                    ...(body.voiceProvider === "groq" && body.voiceApiKey
                      ? { apiKey: body.voiceApiKey }
                      : {}),
                  },
                  openai: {
                    ...persistedSettings.openai,
                    ...(body.openai || {}),
                    ...(body.voiceProvider === "openai" && body.voiceApiKey
                      ? { apiKey: body.voiceApiKey }
                      : {}),
                  },
                  custom: {
                    ...persistedSettings.custom,
                    ...(body.custom || {}),
                    ...(body.voiceEndpoint ? { endpoint: body.voiceEndpoint } : {}),
                    ...(body.voiceModel ? { model: body.voiceModel } : {}),
                    ...(body.voiceProvider === "custom" && body.voiceApiKey
                      ? { apiKey: body.voiceApiKey }
                      : {}),
                  },
                  sessionPromptTtlMinutes:
                    body.sessionPromptTtlMinutes ?? persistedSettings.sessionPromptTtlMinutes,
                });
                await saveDashboardSettings(state.stateDirectory, persistedSettings);

                const activeProvider = persistedSettings.activeProvider ?? "cloudflare";
                let activeKey: string | undefined;
                let activeAccountId: string | undefined;
                let activeEndpoint: string | undefined;
                let activeModel: string | undefined;

                if (activeProvider === "cloudflare") {
                  activeKey = persistedSettings.cloudflare?.apiToken;
                  activeAccountId = persistedSettings.cloudflare?.accountId;
                } else if (activeProvider === "groq") {
                  activeKey = persistedSettings.groq?.apiKey;
                } else if (activeProvider === "openai") {
                  activeKey = persistedSettings.openai?.apiKey;
                } else if (activeProvider === "custom") {
                  activeKey = persistedSettings.custom?.apiKey || "custom";
                  activeEndpoint = persistedSettings.custom?.endpoint;
                  activeModel = persistedSettings.custom?.model;
                }

                if (activeKey) {
                  const newTranscriber = new VoiceTranscriber({
                    apiKey: activeKey,
                    accountId: activeAccountId,
                    provider: activeProvider,
                    endpoint: activeEndpoint,
                    model: activeModel,
                  });
                  telegramRuntimeRef.value?.setTranscriber(newTranscriber);
                }

                return Response.json({ success: true, message: "設定已成功儲存並即時生效" });
              } catch (err) {
                return Response.json(
                  { success: false, message: (err as Error).message },
                  { status: 500 },
                );
              }
            })();
          }

          if (
            url.pathname !== "/v1/health" &&
            url.pathname !== "/v1/status" &&
            url.pathname !== "/v1/connect" &&
            url.pathname !== "/v1/control/stop"
          ) {
            return new Response("Not found", { status: 404 });
          }
          if (
            !isAuthorized(
              request.headers.get("authorization"),
              state.brokerSecret,
              url.searchParams.get("token"),
            )
          ) {
            return new Response("Unauthorized", { status: 401 });
          }
          if (url.pathname === "/v1/health") {
            return Response.json({
              service: "opencode-telegram-link",
              machineId: state.machineId,
              protocol: PROTOCOL_VERSION,
            });
          }
          if (url.pathname === "/v1/status") {
            return Response.json({
              service: "opencode-telegram-link",
              machineId: state.machineId,
              protocol: PROTOCOL_VERSION,
              bindHost,
              connections: registry.connectionCount,
              routes: registry.routeCount,
            });
          }
          if (url.pathname === "/v1/control/stop") {
            if (request.method !== "POST")
              return new Response("Method not allowed", { status: 405 });
            setTimeout(() => void broker?.stop(), 0);
            return Response.json({ status: "stopping" });
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
            handleMessage(
              socket,
              message,
              state.machineId,
              registry,
              pendingCommands,
              activeConfigFingerprint,
              ensureTelegramRuntime,
              () => telegramRuntimeRef.value,
            );
          },
          close(socket) {
            connections.delete(socket);
            registry.removeConnection(socket.data.connectionId);
            if (registry.connectionCount === 0) activeConfigFingerprint.value = undefined;
            failPendingCommands(pendingCommands, "route disconnected", socket.data.connectionId);
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
      pendingCommands,
      telegramRuntimeRef,
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

export async function fetchBrokerStatus(
  port: number,
  brokerSecret: string,
): Promise<z.infer<typeof BrokerStatusSchema> | undefined> {
  try {
    const response = await fetch(`http://${LOOPBACK_HOST}:${port}/v1/status`, {
      headers: { authorization: `Bearer ${brokerSecret}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    return BrokerStatusSchema.parse(await response.json());
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

class BrokerTelegramRuntime {
  readonly #config: TelegramRuntimeConfig;
  readonly #database: StateDatabase;
  readonly #registry: RouteRegistry;
  readonly #api: TelegramBotApi;
  readonly #outbox: TelegramOutboxWorker;
  readonly #poller: TelegramPoller;
  readonly #deliveryIntervalMs: number;
  readonly #now: () => number;
  readonly #startedAt = Date.now();
  #started = false;
  #deliveryTimer: ReturnType<typeof setInterval> | undefined;
  #delivering = false;
  #transcriber: VoiceTranscriber | undefined;

  setTranscriber(transcriber: VoiceTranscriber | undefined): void {
    this.#transcriber = transcriber;
  }

  constructor(input: {
    config: TelegramRuntimeConfig;
    database: StateDatabase;
    registry: RouteRegistry;
    dispatcher: { sendCommand(command: BrokerCommand): Promise<CommandResult> };
    api: TelegramBotApi;
    deliveryIntervalMs: number;
    pollLongPollSeconds?: number;
    now: () => number;
  }) {
    this.#config = input.config;
    this.#database = input.database;
    this.#registry = input.registry;
    this.#api = input.api;
    this.#deliveryIntervalMs = input.deliveryIntervalMs;
    this.#now = input.now;
    this.#outbox = new TelegramOutboxWorker({ api: input.api, database: input.database });
    const authorizer = new TelegramUpdateAuthorizer({
      userId: input.config.userId,
      chatId: input.config.chatId,
    });

    const voiceApiKey =
      input.config.voiceApiKey ??
      process.env.GROQ_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.CLOUDFLARE_API_TOKEN ??
      process.env.CF_API_TOKEN;

    const voiceAccountId =
      input.config.voiceAccountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;

    this.#transcriber = voiceApiKey
      ? new VoiceTranscriber({
          apiKey: voiceApiKey,
          accountId: voiceAccountId,
          provider:
            input.config.voiceProvider ??
            (process.env.CLOUDFLARE_API_TOKEN ? "cloudflare" : "groq"),
          model: input.config.voiceModel,
        })
      : undefined;

    const validatedHandler = createValidatedInteractionHandler(
      authorizer,
      {
        database: input.database,
        isRouteLive: (route) => input.registry.resolve(route) !== undefined,
        now: input.now,
      },
      async (interaction, update) => {
        if (update.callback_query) {
          void input.api
            .answerCallbackQuery({
              callbackQueryId: update.callback_query.id,
            })
            .catch(() => {});
        }
        const outcome = await submitTelegramInteraction(input.dispatcher, interaction);
        await this.#sendInteractionFeedback(interaction.chatId, outcome.feedback);
        return {
          disposition: outcome.result.status === "accepted" ? "acknowledged" : "failed",
          actionId: outcome.result.commandId,
          payloadHash: createHash("sha256")
            .update(`${outcome.result.status}:${outcome.result.reason ?? ""}`)
            .digest("hex"),
        } satisfies UpdateDisposition;
      },
    );

    this.#poller = new TelegramPoller({
      api: input.api,
      database: input.database,
      handleUpdate: async (update) => {
        const auth = authorizer.authorize(update);
        if (!auth.authorized) {
          return {
            disposition: "rejected",
            payloadHash: createHash("sha256").update(JSON.stringify(update)).digest("hex"),
          };
        }

        const voiceOrAudio = update.message?.voice ?? update.message?.audio;
        if (voiceOrAudio) {
          if (!this.#transcriber) {
            await input.api.sendMessage({
              chatId: input.config.chatId,
              text: "⚠️ 尚未設定語音辨識 API Key，無法處理語音訊息。請在 Web 設定頁或 opencode.json 中加入金鑰。",
              parseMode: "HTML",
            });
            return {
              disposition: "acknowledged",
              actionId: randomUUID(),
              payloadHash: createHash("sha256").update(JSON.stringify(update)).digest("hex"),
            };
          }

          try {
            const fileInfo = await input.api.getFile(voiceOrAudio.file_id);
            if (!fileInfo.file_path) {
              throw new Error("Telegram did not return file path");
            }
            const audioBytes = await input.api.downloadFile(fileInfo.file_path);
            const transcribedText = await this.#transcriber.transcribe(audioBytes, {
              mimeType: voiceOrAudio.mime_type ?? "audio/ogg",
              fileName: "voice.ogg",
            });

            if (!transcribedText) {
              await input.api.sendMessage({
                chatId: input.config.chatId,
                text: "🎙️ <i>無法辨識語音內容，請再試一次。</i>",
                parseMode: "HTML",
              });
              return {
                disposition: "acknowledged",
                actionId: randomUUID(),
                payloadHash: createHash("sha256").update(JSON.stringify(update)).digest("hex"),
              };
            }

            // If it is a reply to an existing message:
            if (update.message?.reply_to_message) {
              const syntheticUpdate: TelegramUpdate = {
                ...update,
                message: {
                  ...update.message,
                  text: transcribedText,
                },
              };
              await input.api.sendMessage({
                chatId: input.config.chatId,
                text: `🎙️ <b>語音轉文字：</b> <i>「${transcribedText}」</i>`,
                parseMode: "HTML",
              });
              return await validatedHandler(syntheticUpdate);
            }

            // Direct voice command:
            let commandText = transcribedText;
            const lower = transcribedText.toLowerCase();

            // Map common spoken phrases to slash commands
            if (
              lower.startsWith("run ") ||
              lower.startsWith("執行 ") ||
              lower.startsWith("派工 ")
            ) {
              commandText = `/run ${transcribedText.replace(/^(run|執行|派工)\s+/i, "")}`;
            } else if (lower === "status" || lower === "狀態" || lower === "系統狀態") {
              commandText = "/status";
            } else if (
              lower === "nodes" ||
              lower === "主機" ||
              lower === "主機列表" ||
              lower === "電腦"
            ) {
              commandText = "/nodes";
            } else if (lower === "sessions" || lower === "任務列表" || lower === "工作階段") {
              commandText = "/sessions";
            } else if (lower === "help" || lower === "說明" || lower === "幫助") {
              commandText = "/help";
            } else if (!isSlashCommand(commandText)) {
              // If not a slash command, treat as /run <speech>
              commandText = `/run ${transcribedText}`;
            }

            const replyText = await executeSlashCommand({
              text: commandText,
              locale: "zh-TW",
              registry: input.registry,
              dispatcher: input.dispatcher,
              startedAt: this.#startedAt,
              packageVersion: "3.0.0",
            });

            await input.api.sendMessage({
              chatId: input.config.chatId,
              text: `🎙️ <b>語音指令：</b> <i>「${transcribedText}」</i>\n\n${replyText}`,
              parseMode: "HTML",
            });

            return {
              disposition: "acknowledged",
              actionId: randomUUID(),
              payloadHash: createHash("sha256").update(transcribedText).digest("hex"),
            };
          } catch (error) {
            logTelegramRuntimeError("voice_transcription", error);
            const errDesc = error instanceof Error ? error.message : "語音處理失敗";
            await input.api.sendMessage({
              chatId: input.config.chatId,
              text: `❌ 語音辨識錯誤：${errDesc}`,
              parseMode: "HTML",
            });
            return {
              disposition: "failed",
              payloadHash: createHash("sha256").update(JSON.stringify(update)).digest("hex"),
            };
          }
        }

        const messageText = update.message?.text?.trim();
        if (messageText && isSlashCommand(messageText)) {
          try {
            const replyText = await executeSlashCommand({
              text: messageText,
              locale: "zh-TW",
              registry: input.registry,
              dispatcher: input.dispatcher,
              startedAt: this.#startedAt,
              packageVersion: "3.0.0",
            });
            await input.api.sendMessage({
              chatId: input.config.chatId,
              text: replyText,
              parseMode: "HTML",
            });
            return {
              disposition: "acknowledged",
              actionId: randomUUID(),
              payloadHash: createHash("sha256").update(messageText).digest("hex"),
            };
          } catch (error) {
            logTelegramRuntimeError("slash_command", error);
            return {
              disposition: "failed",
              payloadHash: createHash("sha256").update(messageText).digest("hex"),
            };
          }
        }

        return await validatedHandler(update);
      },
      ...(input.pollLongPollSeconds !== undefined
        ? { longPollSeconds: input.pollLongPollSeconds }
        : {}),
      now: input.now,
    });
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#deliveryTimer = setInterval(() => this.#deliverSoon(), this.#deliveryIntervalMs);
    this.#deliveryTimer.unref();
    void this.#poller.start().catch((error) => logTelegramRuntimeError("poller", error));
    this.#deliverSoon();
  }

  async stop(): Promise<void> {
    if (this.#deliveryTimer) clearInterval(this.#deliveryTimer);
    this.#deliveryTimer = undefined;
    await this.#poller.stop();
  }

  publish(notification: NormalizedNotification): "queued" | "duplicate" {
    if (!this.#registry.resolve(notification.route)) {
      throw new RouteRegistrationError("ROUTE_STALE", "notification route is offline");
    }
    const now = this.#now();
    const idempotencyKey = notificationIdempotencyKey(notification);
    const expiresAt = notificationExpiresAt(notification, this.#config, now);
    if (!this.#database.claimNotification(idempotencyKey, now + NOTIFICATION_DEDUPE_TTL_MS, now)) {
      return "duplicate";
    }
    const rendered = renderTelegramNotification(notification);
    this.#database.enqueueOutbox({
      idempotencyKey,
      chatId: this.#config.chatId,
      payload: JSON.stringify({
        ...rendered,
        disableNotification: notification.kind === "session.completed",
        ...notificationBinding(notification, expiresAt),
      }),
      priority: notificationPriority(notification.kind),
      nextAttemptAt: now,
      expiresAt,
      createdAt: now,
    });
    this.#deliverSoon();
    return "queued";
  }

  #deliverSoon(): void {
    if (this.#delivering) return;
    this.#delivering = true;
    void this.#outbox
      .deliverBatch(this.#now())
      .catch((error) => logTelegramRuntimeError("delivery", error))
      .finally(() => {
        this.#delivering = false;
      });
  }

  async #sendInteractionFeedback(
    chatId: string,
    feedback: Parameters<typeof interactionFeedbackText>[1],
  ): Promise<void> {
    await this.#api
      .sendMessage({
        chatId,
        text: interactionFeedbackText(this.#config.locale, feedback),
        disableNotification: true,
      })
      .catch((error) => logTelegramRuntimeError("feedback", error));
  }
}

function notificationBinding(
  notification: NormalizedNotification,
  expiresAt: number,
): { binding?: NonNullable<TelegramOutboxPayload["binding"]> } {
  switch (notification.kind) {
    case "session.completed":
      return { binding: { route: notification.route, kind: "session_prompt", expiresAt } };
    case "question.pending":
      return {
        binding: {
          route: notification.route,
          kind: "question_reply",
          interactionId: notification.interactionId,
          expiresAt,
          ...questionCallbackButtons(notification),
        },
      };
    case "permission.pending":
      return {
        binding: {
          route: notification.route,
          kind: "permission_notice",
          interactionId: notification.interactionId,
          expiresAt,
          ...permissionCallbackButtons(notification.locale),
        },
      };
    case "session.error":
      return {};
  }
}

function permissionCallbackButtons(locale: SupportedLocale): {
  callbackButtons: Array<{ text: string; action: string; payload: string }>;
} {
  return {
    callbackButtons: [
      {
        text: translate(locale, "button.allowOnce"),
        action: "permission.reply",
        payload: "once",
      },
      {
        text: translate(locale, "button.alwaysAllow"),
        action: "permission.reply",
        payload: "always",
      },
      {
        text: translate(locale, "button.reject"),
        action: "permission.reply",
        payload: "reject",
      },
    ],
  };
}

function questionCallbackButtons(
  notification: Extract<NormalizedNotification, { kind: "question.pending" }>,
): { callbackButtons?: Array<{ text: string; action: string; payload: string }> } {
  if (notification.questions.length !== 1) return {};
  const question = notification.questions[0];
  if (!question || question.multiple || question.options.length === 0) return {};
  return {
    callbackButtons: question.options.slice(0, 10).map((option) => ({
      text: truncateButtonText(option.label),
      action: "question.option",
      payload: JSON.stringify({ answers: [[option.label]] }),
    })),
  };
}

function notificationExpiresAt(
  notification: NormalizedNotification,
  config: TelegramRuntimeConfig,
  now: number,
): number {
  if (notification.kind === "question.pending" || notification.kind === "permission.pending") {
    return now + config.questionTtlMinutes * 60_000;
  }
  if (notification.kind === "session.completed") {
    return now + config.sessionPromptTtlMinutes * 60_000;
  }
  return now + 24 * 60 * 60_000;
}

function notificationPriority(kind: NormalizedNotification["kind"]): number {
  switch (kind) {
    case "question.pending":
    case "permission.pending":
      return 3;
    case "session.error":
      return 2;
    case "session.completed":
      return 1;
  }
}

function notificationIdempotencyKey(notification: NormalizedNotification): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        notification.route.machineId,
        notification.route.instanceId,
        notification.route.projectId,
        notification.route.sessionId,
        notification.route.routeGeneration,
        notification.kind,
        notification.eventId,
      ]),
    )
    .digest("hex");
}

function truncateButtonText(text: string): string {
  return text.length <= 64 ? text : `${text.slice(0, 61)}...`;
}

function logTelegramRuntimeError(component: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`opencode-telegram-link: Telegram ${component} failed: ${message}\n`);
}

function handleMessage(
  socket: Bun.ServerWebSocket<BrokerConnectionData>,
  message: string | Buffer<ArrayBuffer>,
  machineId: string,
  registry: RouteRegistry,
  pendingCommands: Map<string, PendingBrokerCommand>,
  activeConfigFingerprint: { value: string | undefined },
  ensureTelegramRuntime: (config: TelegramRuntimeConfig) => BrokerTelegramRuntime,
  currentTelegramRuntime: () => BrokerTelegramRuntime | undefined,
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
          envelope.payload.hostLabel,
          envelope.payload.projectLabel,
        );
        if (envelope.payload.telegram) ensureTelegramRuntime(envelope.payload.telegram);
        activeConfigFingerprint.value ??= envelope.payload.configFingerprint;
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
      case "notification.publish": {
        const runtime = currentTelegramRuntime();
        if (!runtime) {
          throw new RouteRegistrationError(
            "TELEGRAM_NOT_CONFIGURED",
            "Telegram runtime has not been registered",
          );
        }
        const status = runtime.publish(envelope.payload.notification);
        send(socket, {
          protocol: PROTOCOL_VERSION,
          type: "notification.published",
          requestId: envelope.requestId,
          sentAt: new Date().toISOString(),
          payload: { eventId: envelope.payload.notification.eventId, status },
        });
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
      case "command.result": {
        const pending = pendingCommands.get(envelope.requestId);
        if (!pending || pending.connectionId !== socket.data.connectionId) return;
        pendingCommands.delete(envelope.requestId);
        clearTimeout(pending.timeout);
        pending.resolve(
          envelope.payload.commandId === pending.commandId
            ? envelope.payload
            : {
                commandId: pending.commandId,
                status: "indeterminate",
                reason: "command identity mismatch",
              },
        );
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

type PendingBrokerCommand = {
  connectionId: string;
  commandId: string;
  resolve: (result: CommandResult) => void;
  timeout: ReturnType<typeof setTimeout>;
};

function failPendingCommands(
  pendingCommands: Map<string, PendingBrokerCommand>,
  reason: string,
  connectionId?: string,
): void {
  for (const [requestId, pending] of pendingCommands) {
    if (connectionId && pending.connectionId !== connectionId) continue;
    pendingCommands.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve({ commandId: pending.commandId, status: "stale", reason });
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

function isAuthorized(
  authorization: string | null,
  brokerSecret: string,
  urlToken?: string | null,
): boolean {
  if (urlToken) {
    const supplied = createHash("sha256").update(urlToken).digest();
    const expected = createHash("sha256").update(brokerSecret).digest();
    if (timingSafeEqual(supplied, expected)) return true;
  }
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = createHash("sha256").update(authorization.slice(7)).digest();
  const expected = createHash("sha256").update(brokerSecret).digest();
  return timingSafeEqual(supplied, expected);
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
