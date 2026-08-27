import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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
  let broker: BrokerServer | undefined;
  const telegramRuntimeRef: { value: BrokerTelegramRuntime | undefined } = { value: undefined };
  const bindHost = options.bindHost ?? DEFAULT_BIND_HOST;
  const ensureTelegramRuntime = (config: TelegramRuntimeConfig): BrokerTelegramRuntime => {
    telegramRuntimeRef.value ??= new BrokerTelegramRuntime({
      config,
      database,
      registry,
      dispatcher: {
        sendCommand: async (command) => {
          if (!broker) {
            return { commandId: command.commandId, status: "stale", reason: "broker is starting" };
          }
          return await broker.sendCommand(command);
        },
      },
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
      process.env.OPENAI_API_KEY;

    const transcriber = voiceApiKey
      ? new VoiceTranscriber({
          apiKey: voiceApiKey,
          provider: input.config.voiceProvider ?? "groq",
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
          if (!transcriber) {
            await input.api.sendMessage({
              chatId: input.config.chatId,
              text: "⚠️ 尚未設定 Groq / OpenAI 語音辨識 API Key，無法處理語音訊息。請在 opencode.json 中加入 voice.apiKey。",
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
            const transcribedText = await transcriber.transcribe(audioBytes, {
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
            } else if (
              lower === "sessions" ||
              lower === "任務列表" ||
              lower === "工作階段"
            ) {
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
