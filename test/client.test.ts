import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrokerServer,
  probeBroker,
  type StartBrokerOptions,
  startBroker,
} from "../src/broker";
import { BrokerClient, type BrokerClientOptions, brokerRuntimeCommand } from "../src/plugin/client";
import type {
  BrokerCommand,
  NormalizedNotification,
  RouteKey,
  TelegramRuntimeConfig,
} from "../src/protocol";
import { discoveryRecordPath, loadOrCreateStateIdentity } from "../src/state";
import {
  type SendMessageInput,
  submitTelegramInteraction,
  type TelegramBot,
  TelegramBotApi,
  type TelegramUpdate,
  TelegramUpdateSchema,
  validateTelegramInteraction,
} from "../src/telegram";

const TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const temporaryDirectories: string[] = [];
const brokers: BrokerServer[] = [];
const clients: BrokerClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.stop();
  }
  for (const broker of brokers.splice(0)) {
    await broker.stop();
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => safeRemove(directory)));
});

async function safeRemove(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(directory, { recursive: true, force: true });
}

describe("BrokerClient lifecycle", () => {
  test("uses a Bun runtime command for detached broker spawn", () => {
    expect(brokerRuntimeCommand().command).toMatch(/bun|npx/);
  });

  test("starts a missing broker and registers routes that were declared before connection", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const port = await availablePort();
    const client = createClient(stateDirectory, port);
    clients.push(client);
    await client.upsertRoute(routeIntent());

    await client.start();

    expect(client.connected).toBe(true);
    expect(brokers).toHaveLength(1);
    expect(brokers[0]?.registry.connectionCount).toBe(1);
    expect(brokers[0]?.registry.routeCount).toBe(1);
    expect(client.activeRoute("opaque-project-id", "ses_123")).toBeDefined();
  });

  test("reconnects and re-registers routes under a new generation", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const port = await availablePort();
    const client = createClient(stateDirectory, port);
    clients.push(client);
    await client.upsertRoute(routeIntent());
    await client.start();
    const previousGeneration = client.activeRoute("opaque-project-id", "ses_123")?.routeGeneration;

    await brokers[0]?.stop();
    await waitUntil(() => brokers.length === 2 && brokers[1]?.registry.routeCount === 1);

    expect(client.connected).toBe(true);
    expect(client.activeRoute("opaque-project-id", "ses_123")?.routeGeneration).not.toBe(
      previousGeneration,
    );
  });

  test("removes a live route without affecting the connection", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const port = await availablePort();
    const client = createClient(stateDirectory, port);
    clients.push(client);
    await client.start();
    await client.upsertRoute(routeIntent());

    await client.removeRoute("opaque-project-id", "ses_123");

    expect(client.connected).toBe(true);
    expect(brokers[0]?.registry.routeCount).toBe(0);
  });

  test("publishes normalized notifications through the broker", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const port = await availablePort();
    const sent: SendMessageInput[] = [];
    const client = createClient(stateDirectory, port, {
      telegram: telegramConfig(),
      brokerOptions: { telegramApiFactory: () => new FakeClientTelegramBotApi(sent) },
    });
    clients.push(client);
    await client.start();
    await client.upsertRoute(routeIntent());
    const route = client.activeRoute("opaque-project-id", "ses_123");
    if (!route || !brokers[0]) throw new Error("expected active route");

    try {
      const res = await client.publishNotification(notification(route));
      expect(res).toBe("queued");
    } catch (err) {
      console.error("publishNotification failed with:", err);
      throw err;
    }
    await waitUntil(() => sent.length === 1);

    expect(sent[0]).toMatchObject({ chatId: "123456789", parseMode: "HTML" });
    expect(brokers[0].database.getMessageRoute("123456789", 77)).toMatchObject({
      kind: "session_prompt",
      route,
      status: "active",
    });
  });

  test("dispatches broker commands only to the exact owning route", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const port = await availablePort();
    const handled: BrokerCommand[] = [];
    const client = createClient(stateDirectory, port, {
      onCommand: (command) => {
        handled.push(command);
        return { commandId: command.commandId, status: "accepted" };
      },
    });
    clients.push(client);
    await client.start();
    await client.upsertRoute(routeIntent());
    const route = client.activeRoute("opaque-project-id", "ses_123");
    if (!route || !brokers[0]) throw new Error("expected active route");

    const result = await brokers[0].sendCommand({
      type: "session.prompt",
      commandId: crypto.randomUUID(),
      route,
      text: "Continue safely",
    });
    const offline = await brokers[0].sendCommand({
      type: "session.prompt",
      commandId: crypto.randomUUID(),
      route: { ...route, sessionId: "ses_offline" },
      text: "Must not reroute",
    });

    expect(result.status).toBe("accepted");
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ type: "session.prompt", route, text: "Continue safely" });
    expect(offline).toMatchObject({ status: "stale", reason: "route is offline" });
  });

  test("dispatches validated Telegram interactions only to the exact bound route", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const port = await availablePort();
    const handled = new Map<string, BrokerCommand[]>();

    const routeSpecs = [
      { owner: "target", projectId: "opaque-project-alpha", sessionId: "ses_shared" },
      { owner: "other-project", projectId: "opaque-project-bravo", sessionId: "ses_shared" },
      { owner: "other-session", projectId: "opaque-project-alpha", sessionId: "ses_other" },
      { owner: "other-instance", projectId: "opaque-project-alpha", sessionId: "ses_instance" },
      { owner: "question", projectId: "opaque-project-charlie", sessionId: "ses_question" },
    ] as const;
    const routes = new Map<(typeof routeSpecs)[number]["owner"], RouteKey>();

    for (const spec of routeSpecs) {
      handled.set(spec.owner, []);
      const client = createClient(stateDirectory, port, {
        onCommand: (command) => {
          handled.get(spec.owner)?.push(command);
          return { commandId: command.commandId, status: "accepted" };
        },
      });
      clients.push(client);
      await client.start();
      const route = await client.upsertRoute(
        routeIntent({
          projectId: spec.projectId,
          sessionId: spec.sessionId,
          projectLabel: spec.owner,
          sessionLabel: spec.sessionId,
        }),
      );
      if (!route) throw new Error(`expected active route for ${spec.owner}`);
      routes.set(spec.owner, route);
    }
    const broker = brokers[0];
    if (!broker) throw new Error("expected broker");

    const promptBindings = [
      ["target", 77, "Continue target"],
      ["other-project", 78, "Continue other project"],
      ["other-session", 79, "Continue other session"],
      ["other-instance", 80, "Continue other instance"],
    ] as const;
    for (const [owner, messageId] of promptBindings) {
      saveRoute(broker, routes.get(owner), "session_prompt", { messageId });
    }
    saveRoute(broker, routes.get("question"), "question_reply", {
      messageId: 81,
      interactionId: "question_1",
    });
    broker.database.saveCallbackToken({
      token: "question-token",
      chatId: "123456789",
      messageId: 81,
      action: "question.option",
      payload: JSON.stringify({ answers: [["Option A"]] }),
      createdAt: 1_000,
      expiresAt: 10_000,
    });

    for (const [owner, messageId, text] of promptBindings) {
      const validation = validateTelegramInteraction(
        parseUpdate(messageReply({ updateId: messageId, replyToMessageId: messageId, text })),
        subject("message"),
        {
          database: broker.database,
          isRouteLive: (route) => broker.registry.resolve(route) !== undefined,
          now: () => 2_000,
        },
      );
      if (!validation.accepted) throw new Error(`expected ${owner} interaction to validate`);

      await expect(
        submitTelegramInteraction(broker, validation.interaction),
      ).resolves.toMatchObject({
        feedback: "accepted",
      });

      for (const spec of routeSpecs) {
        const commands = handled.get(spec.owner) ?? [];
        expect(commands).toHaveLength(spec.owner === owner ? 1 : 0);
      }
      const commands = handled.get(owner) ?? [];
      expect(commands[0]).toMatchObject({
        type: "session.prompt",
        route: routes.get(owner),
        text,
      });
      commands.length = 0;
    }

    const questionValidation = validateTelegramInteraction(
      parseUpdate(callbackUpdate({ updateId: 90, messageId: 81, token: "question-token" })),
      subject("callback_query"),
      {
        database: broker.database,
        isRouteLive: (route) => broker.registry.resolve(route) !== undefined,
        now: () => 2_000,
      },
    );
    if (!questionValidation.accepted) throw new Error("expected question interaction to validate");
    await expect(
      submitTelegramInteraction(broker, questionValidation.interaction),
    ).resolves.toMatchObject({
      feedback: "accepted",
    });
    expect(handled.get("question")).toHaveLength(1);
    expect(handled.get("question")?.[0]).toMatchObject({
      type: "question.reply",
      route: routes.get("question"),
      interactionId: "question_1",
      answers: [["Option A"]],
    });
    for (const spec of routeSpecs.filter((spec) => spec.owner !== "question")) {
      expect(handled.get(spec.owner)).toHaveLength(0);
    }
    const questionCommands = handled.get("question");
    if (!questionCommands) throw new Error("expected question command log");
    questionCommands.length = 0;

    const targetRoute = routes.get("target");
    if (!targetRoute) throw new Error("expected target route");
    const offlineRoute = { ...targetRoute, sessionId: "ses_offline" };
    saveRoute(broker, offlineRoute, "session_prompt", { messageId: 82 });
    expect(
      validateTelegramInteraction(
        parseUpdate(
          messageReply({ updateId: 91, replyToMessageId: 82, text: "Must not dispatch" }),
        ),
        subject("message"),
        {
          database: broker.database,
          isRouteLive: (route) => broker.registry.resolve(route) !== undefined,
          now: () => 2_000,
        },
      ),
    ).toMatchObject({ accepted: false, reason: "ROUTE_STALE" });

    saveRoute(broker, routes.get("target"), "permission_notice", { messageId: 83 });
    const permissionValidation = validateTelegramInteraction(
      parseUpdate(messageReply({ updateId: 92, replyToMessageId: 83, text: "Allow" })),
      subject("message"),
      {
        database: broker.database,
        isRouteLive: (route) => broker.registry.resolve(route) !== undefined,
        now: () => 2_000,
      },
    );
    if (!permissionValidation.accepted)
      throw new Error("expected permission interaction to validate");
    await expect(
      submitTelegramInteraction(broker, permissionValidation.interaction),
    ).resolves.toMatchObject({
      feedback: "terminal_only",
      result: { status: "rejected", reason: "terminal intervention required" },
    });

    saveRoute(broker, routes.get("target"), "session_prompt", { messageId: 84 });
    broker.database.saveCallbackToken({
      token: "wrong-kind-token",
      chatId: "123456789",
      messageId: 84,
      action: "question.option",
      payload: JSON.stringify({ answers: [["Option B"]] }),
      createdAt: 1_000,
      expiresAt: 10_000,
    });
    expect(
      validateTelegramInteraction(
        parseUpdate(callbackUpdate({ updateId: 93, messageId: 84, token: "wrong-kind-token" })),
        subject("callback_query"),
        {
          database: broker.database,
          isRouteLive: (route) => broker.registry.resolve(route) !== undefined,
          now: () => 2_000,
        },
      ),
    ).toMatchObject({ accepted: false, reason: "ACTION_KIND_MISMATCH" });

    for (const spec of routeSpecs) expect(handled.get(spec.owner)).toHaveLength(0);
  });

  test("keeps a broker alive while connected and lets it idle out after disconnect", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const port = await availablePort();
    const broker = await startBroker({ stateDirectory, port, idleTimeoutMs: 40 });
    brokers.push(broker);
    const identity = await loadOrCreateStateIdentity(stateDirectory);
    const client = new BrokerClient({
      stateDirectory,
      port,
      packageVersion: "0.0.0",
      openCodeVersion: "1.18.18",
      heartbeatIntervalMs: 10,
    });
    clients.push(client);
    await client.start();

    await Bun.sleep(80);
    expect(await probeBroker(port, identity.brokerSecret)).toBeDefined();

    await client.stop();
    await broker.finished;
    expect(await probeBroker(port, identity.brokerSecret)).toBeUndefined();
    expect(await Bun.file(discoveryRecordPath(stateDirectory)).exists()).toBe(false);
  });

  test("writes and safely removes the informational discovery record", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const broker = await startBroker({ stateDirectory, port: 0 });
    brokers.push(broker);
    const path = discoveryRecordPath(stateDirectory);

    expect(await Bun.file(path).exists()).toBe(true);
    expect(await Bun.file(path).json()).toMatchObject({
      port: broker.port,
      pid: process.pid,
      protocol: { major: 1, minor: 0 },
    });

    await broker.stop();
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("keeps durable state across broker restarts", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const first = await startBroker({ stateDirectory, port: 0 });
    brokers.push(first);
    const now = Date.now();
    expect(first.database.claimNotification("event_1", now + 10_000, now)).toBe(true);
    first.database.commitInboundUpdate({
      updateId: 12,
      disposition: "acknowledged",
      occurredAt: 1_000,
    });
    await first.stop();

    const second = await startBroker({ stateDirectory, port: 0 });
    brokers.push(second);
    expect(second.database.claimNotification("event_1", now + 20_000, now + 1_000)).toBe(false);
    expect(second.database.getTelegramUpdateOffset()).toBe(13);
  });

  test("runs bounded state maintenance while the broker is active", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const broker = await startBroker({
      stateDirectory,
      port: 0,
      idleTimeoutMs: 5_000,
      maintenanceIntervalMs: 10,
    });
    brokers.push(broker);
    broker.database.saveMessageRoute({
      chatId: "123456789",
      messageId: 1,
      route: {
        machineId: broker.machineId,
        instanceId: crypto.randomUUID(),
        projectId: "opaque-project-id",
        sessionId: "ses_123",
        routeGeneration: crypto.randomUUID(),
      },
      kind: "session_prompt",
      createdAt: Date.now(),
      expiresAt: Date.now() - 1,
      status: "active",
    });

    await waitUntil(() => broker.database.inspect().messageRoutes.expired === 1);

    expect(broker.database.inspect().messageRoutes.active).toBe(0);
  });
});

function createClient(
  stateDirectory: string,
  port: number,
  options: Pick<BrokerClientOptions, "onCommand" | "telegram"> & {
    brokerOptions?: Pick<StartBrokerOptions, "telegramApiFactory">;
  } = {},
): BrokerClient {
  const { brokerOptions, ...clientOptions } = options;
  return new BrokerClient({
    stateDirectory,
    port,
    packageVersion: "0.0.0",
    openCodeVersion: "1.18.18",
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 1_000,
    heartbeatIntervalMs: 500,
    reconnectMinDelayMs: 20,
    reconnectMaxDelayMs: 100,
    random: () => 0,
    ...clientOptions,
    spawnBroker: async () => {
      const broker = await startBroker({
        stateDirectory,
        port,
        idleTimeoutMs: 5_000,
        ...brokerOptions,
      });
      brokers.push(broker);
    },
  });
}

function telegramConfig(): TelegramRuntimeConfig {
  return {
    botToken: TOKEN,
    userId: "123456789",
    chatId: "123456789",
    locale: "en",
    sessionPromptTtlMinutes: 60,
    questionTtlMinutes: 30,
  };
}

function notification(route: RouteKey): NormalizedNotification {
  return {
    kind: "session.completed",
    eventId: "event_1",
    route,
    locale: "en",
    projectLabel: "backend",
    sessionLabel: "Implement auth",
    occurredAt: new Date(1_000).toISOString(),
  };
}

class FakeClientTelegramBotApi extends TelegramBotApi {
  readonly #sent: SendMessageInput[];
  #nextMessageId = 77;

  constructor(sent: SendMessageInput[]) {
    super({ token: TOKEN, baseUrl: "https://telegram.invalid" });
    this.#sent = sent;
  }

  override async getMe(): Promise<TelegramBot> {
    return { id: 987654321, is_bot: true, first_name: "TestBot" };
  }

  override async deleteWebhook(): Promise<void> {}

  override async getUpdates(input: {
    offset: number;
    timeoutSeconds?: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]> {
    await abortableSleep(20, input.signal);
    return [];
  }

  override async sendMessage(
    input: SendMessageInput,
  ): Promise<{ messageId: number; chatId: string }> {
    this.#sent.push(input);
    return { messageId: this.#nextMessageId++, chatId: input.chatId };
  }
}

async function abortableSleep(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function routeIntent(options: Partial<ReturnType<typeof routeIntentBase>> = {}) {
  return { ...routeIntentBase(), ...options };
}

function routeIntentBase() {
  return {
    projectId: "opaque-project-id",
    sessionId: "ses_123",
    projectLabel: "backend",
    sessionLabel: "Implement auth",
  };
}

function saveRoute(
  broker: BrokerServer,
  route: RouteKey | undefined,
  kind: "session_prompt" | "question_reply" | "permission_notice",
  options: { messageId: number; interactionId?: string },
): void {
  if (!route) throw new Error("expected route");
  broker.database.saveMessageRoute({
    chatId: "123456789",
    messageId: options.messageId,
    route,
    kind,
    ...(options.interactionId ? { interactionId: options.interactionId } : {}),
    createdAt: 1_000,
    expiresAt: 10_000,
    status: "active",
  });
}

function parseUpdate(input: unknown) {
  return TelegramUpdateSchema.parse(input);
}

function subject(kind: "message" | "callback_query") {
  return { kind, userId: "123456789", chatId: "123456789" };
}

function messageReply(options: { updateId: number; replyToMessageId: number; text: string }) {
  return {
    update_id: options.updateId,
    message: {
      message_id: options.updateId + 1_000,
      from: user(),
      chat: chat(),
      date: 1_700_000_000,
      text: options.text,
      reply_to_message: { message_id: options.replyToMessageId, chat: chat() },
    },
  };
}

function callbackUpdate(options: { updateId: number; messageId: number; token: string }) {
  return {
    update_id: options.updateId,
    callback_query: {
      id: `callback_${options.updateId}`,
      from: user(),
      message: {
        message_id: options.messageId,
        chat: chat(),
        date: 1_700_000_000,
        text: "Choose",
      },
      data: options.token,
    },
  };
}

function user() {
  return { id: 123456789, is_bot: false, first_name: "User" };
}

function chat() {
  return { id: 123456789, type: "private" as const };
}

async function availablePort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port ?? 0;
  await reservation.stop(true);
  return port;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(10);
  }
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-telegram-client-"));
  temporaryDirectories.push(directory);
  return directory;
}
