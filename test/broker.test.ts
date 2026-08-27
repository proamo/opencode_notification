import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrokerPortConflictError,
  type BrokerServer,
  type StartBrokerOptions,
  startBroker,
  startOrReuseBroker,
} from "../src/broker";
import {
  BROKER_CAPABILITIES,
  type BrokerEnvelope,
  BrokerEnvelopeSchema,
  PROTOCOL_VERSION,
  type RouteKey,
  type TelegramRuntimeConfig,
} from "../src/protocol";
import { createRouteKey, loadOrCreateStateIdentity } from "../src/state";
import {
  type SendMessageInput,
  type TelegramBot,
  TelegramBotApi,
  type TelegramUpdate,
} from "../src/telegram";

const TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const temporaryDirectories: string[] = [];
const brokers: BrokerServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.stop()));
  for (const socket of sockets.splice(0)) socket.terminate();
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

describe("local broker", () => {
  test("requires authentication for health and WebSocket upgrade", async () => {
    const { broker, secret } = await createBroker();

    expect((await fetch(`http://127.0.0.1:${broker.port}/v1/health`)).status).toBe(401);

    const response = await fetch(`http://127.0.0.1:${broker.port}/v1/health`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: "opencode-telegram-link",
      machineId: broker.machineId,
      protocol: PROTOCOL_VERSION,
    });

    const unauthorized = new WebSocket(`ws://127.0.0.1:${broker.port}/v1/connect`);
    sockets.push(unauthorized);
    const close = waitForClose(unauthorized);
    await expect(close).resolves.toBeDefined();
    expect(broker.registry.connectionCount).toBe(0);
  });

  test("registers multiple instances and keeps identical labels and sessions distinct", async () => {
    const { broker, secret } = await createBroker();
    const first = await connectClient(broker.port, secret);
    const second = await connectClient(broker.port, secret);
    const firstInstance = crypto.randomUUID();
    const secondInstance = crypto.randomUUID();

    await registerClient(first, broker.machineId, firstInstance);
    await registerClient(second, broker.machineId, secondInstance);

    const routeBase = {
      machineId: broker.machineId,
      projectId: "same-opaque-project-id",
      sessionId: "ses_same",
    };
    const firstRoute = createRouteKey({ ...routeBase, instanceId: firstInstance });
    const secondRoute = createRouteKey({ ...routeBase, instanceId: secondInstance });

    await registerRoute(first, firstRoute, "backend", "Implement auth");
    await registerRoute(second, secondRoute, "backend", "Implement auth");

    expect(broker.registry.connectionCount).toBe(2);
    expect(broker.registry.routeCount).toBe(2);
    expect(broker.registry.resolve(firstRoute)?.connectionId).not.toBe(
      broker.registry.resolve(secondRoute)?.connectionId,
    );
  });

  test("rejects routes owned by a different instance", async () => {
    const { broker, secret } = await createBroker();
    const socket = await connectClient(broker.port, secret);
    const instanceId = crypto.randomUUID();
    await registerClient(socket, broker.machineId, instanceId);

    const response = waitForMessage(socket);
    socket.send(
      JSON.stringify({
        ...envelope("route.register"),
        payload: {
          route: createRouteKey({
            machineId: broker.machineId,
            instanceId: crypto.randomUUID(),
            projectId: "opaque-project-id",
            sessionId: "ses_123",
          }),
          projectLabel: "backend",
          sessionLabel: "Implement auth",
        },
      }),
    );

    expect(await response).toMatchObject({
      type: "error",
      payload: { code: "INSTANCE_MISMATCH" },
    });
    expect(broker.registry.routeCount).toBe(0);
  });

  test("supersedes an older generation of the same session route", async () => {
    const { broker, secret } = await createBroker();
    const socket = await connectClient(broker.port, secret);
    const instanceId = crypto.randomUUID();
    await registerClient(socket, broker.machineId, instanceId);
    const base = {
      machineId: broker.machineId,
      instanceId,
      projectId: "opaque-project-id",
      sessionId: "ses_123",
    };
    const previous = createRouteKey(base);
    const current = createRouteKey(base);

    await registerRoute(socket, previous, "backend", "Implement auth");
    await registerRoute(socket, current, "backend", "Implement auth");

    expect(broker.registry.routeCount).toBe(1);
    expect(broker.registry.resolve(previous)?.route).toEqual(current);
    expect(broker.registry.resolve(current)?.route).toEqual(current);
  });

  test("rejects clients missing a required protocol capability", async () => {
    const { broker, secret } = await createBroker();
    const socket = await connectClient(broker.port, secret);
    const response = waitForMessage(socket);
    socket.send(
      JSON.stringify({
        ...envelope("register"),
        payload: {
          packageVersion: "0.0.0",
          openCodeVersion: "1.18.18",
          machineId: broker.machineId,
          instanceId: crypto.randomUUID(),
          configFingerprint: "a".repeat(64),
          capabilities: ["route-registration"],
        },
      }),
    );

    expect(await response).toMatchObject({
      type: "error",
      payload: { code: "CAPABILITY_REQUIRED" },
    });
    await waitUntil(() => broker.registry.connectionCount === 0);
    expect(broker.registry.connectionCount).toBe(0);
  });

  test("accepts concurrent connections with distinct project configuration fingerprints", async () => {
    const { broker, secret } = await createBroker();
    const first = await connectClient(broker.port, secret);
    const second = await connectClient(broker.port, secret);

    await registerClient(first, broker.machineId, crypto.randomUUID(), "a".repeat(64));
    const response = waitForMessage(second);
    second.send(
      JSON.stringify({
        ...envelope("register"),
        payload: {
          packageVersion: "0.0.0",
          openCodeVersion: "1.18.18",
          machineId: broker.machineId,
          instanceId: crypto.randomUUID(),
          configFingerprint: "b".repeat(64),
          capabilities: [...BROKER_CAPABILITIES],
        },
      }),
    );

    expect(await response).toMatchObject({
      type: "registered",
      payload: { machineId: broker.machineId },
    });
    expect(broker.registry.connectionCount).toBe(2);
  });

  test("removes every route when its owning connection closes", async () => {
    const { broker, secret } = await createBroker();
    const socket = await connectClient(broker.port, secret);
    const instanceId = crypto.randomUUID();
    await registerClient(socket, broker.machineId, instanceId);
    const route = createRouteKey({
      machineId: broker.machineId,
      instanceId,
      projectId: "opaque-project-id",
      sessionId: "ses_123",
    });
    await registerRoute(socket, route, "backend", "Implement auth");

    socket.close();
    await waitUntil(() => broker.registry.connectionCount === 0);

    expect(broker.registry.routeCount).toBe(0);
    expect(broker.registry.resolve(route)).toBeUndefined();
  });

  test("registers multiple remote hosts with different machineIds and routes commands independently", async () => {
    const sent: SendMessageInput[] = [];
    const updates: TelegramUpdate[] = [];
    const { broker, secret } = await createBroker({
      telegramApiFactory: () => new FakeTelegramBotApi(sent, updates),
      telegramPollLongPollSeconds: 1,
    });

    const hostA = await connectClient(broker.port, secret);
    const hostB = await connectClient(broker.port, secret);
    const machineA = crypto.randomUUID();
    const machineB = crypto.randomUUID();
    const instanceA = crypto.randomUUID();
    const instanceB = crypto.randomUUID();

    await registerClient(hostA, machineA, instanceA, undefined, telegramConfig());
    await registerClient(hostB, machineB, instanceB);

    const routeA = createRouteKey({
      machineId: machineA,
      instanceId: instanceA,
      projectId: "project-on-host-a",
      sessionId: "session-a",
    });
    const routeB = createRouteKey({
      machineId: machineB,
      instanceId: instanceB,
      projectId: "project-on-host-b",
      sessionId: "session-b",
    });

    await registerRoute(hostA, routeA, "App-A", "Task A");
    await registerRoute(hostB, routeB, "App-B", "Task B");

    expect(broker.registry.connectionCount).toBe(2);
    expect(broker.registry.routeCount).toBe(2);

    // Publish notification from Host B with hostLabel
    const publishResponse = waitForMessage(hostB);
    hostB.send(
      JSON.stringify({
        ...envelope("notification.publish"),
        payload: {
          notification: {
            kind: "session.completed",
            eventId: "evt-host-b",
            route: routeB,
            hostLabel: "Remote-VPS",
            locale: "en",
            projectLabel: "App-B",
            sessionLabel: "Task B",
            occurredAt: new Date().toISOString(),
          },
        },
      }),
    );
    expect(await publishResponse).toMatchObject({
      type: "notification.published",
      payload: { eventId: "evt-host-b", status: "queued" },
    });

    await waitUntil(() => sent.length === 1);
    expect(sent[0]?.text).toContain("[Remote-VPS]");
    expect(sent[0]?.text).toContain("App-B");

    // Reply on Telegram to Host B's notification
    const hostBCommand = waitForMessage(hostB);
    updates.push(
      messageReply({
        updateId: 99,
        replyToMessageId: 77,
        text: "Continue task on VPS",
      }),
    );

    const command = await hostBCommand;
    expect(command).toMatchObject({
      type: "command",
      payload: {
        type: "session.prompt",
        text: "Continue task on VPS",
      },
    });
  });

  test("acknowledges heartbeat only after registration", async () => {
    const { broker, secret } = await createBroker();
    const socket = await connectClient(broker.port, secret);
    await registerClient(socket, broker.machineId, crypto.randomUUID());

    const response = waitForMessage(socket);
    socket.send(JSON.stringify({ ...envelope("heartbeat"), payload: {} }));

    expect(await response).toMatchObject({ type: "heartbeat.ack", payload: {} });
  });

  test("concurrent startup reuses the authenticated singleton", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = reservation.port ?? 0;
    await reservation.stop(true);

    const results = await Promise.all([
      startOrReuseBroker({ stateDirectory, port }),
      startOrReuseBroker({ stateDirectory, port }),
      startOrReuseBroker({ stateDirectory, port }),
    ]);
    const started = results.filter((result) => result.kind === "started");
    const existing = results.filter((result) => result.kind === "existing");

    expect(started).toHaveLength(1);
    expect(existing).toHaveLength(2);
    if (started[0]?.kind !== "started") throw new Error("expected one broker to start");
    brokers.push(started[0].broker);
    expect(existing.every((result) => result.machineId === started[0]?.broker.machineId)).toBe(
      true,
    );
  });

  test("fails visibly when the port belongs to another process", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const occupied = Bun.serve({ port: 0, fetch: () => new Response("not a broker") });

    try {
      await expect(
        startOrReuseBroker({ stateDirectory, port: occupied.port ?? 0 }),
      ).rejects.toBeInstanceOf(BrokerPortConflictError);
    } finally {
      await occupied.stop(true);
    }
  });

  test("can explicitly bind the container interface for Docker port publishing", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const broker = await startBroker({ stateDirectory, port: 0, bindHost: "0.0.0.0" });
    brokers.push(broker);
    const identity = await loadOrCreateStateIdentity(stateDirectory);

    const response = await fetch(`http://127.0.0.1:${broker.port}/v1/status`, {
      headers: { authorization: `Bearer ${identity.brokerSecret}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ bindHost: "0.0.0.0" });
  });

  test("publishes Telegram notifications and routes replies back to the owning session", async () => {
    const sent: SendMessageInput[] = [];
    const updates: TelegramUpdate[] = [];
    const { broker, secret } = await createBroker({
      telegramApiFactory: () => new FakeTelegramBotApi(sent, updates),
      telegramPollLongPollSeconds: 1,
    });
    const socket = await connectClient(broker.port, secret);
    const instanceId = crypto.randomUUID();
    await registerClient(socket, broker.machineId, instanceId, "a".repeat(64), telegramConfig());
    const route = createRouteKey({
      machineId: broker.machineId,
      instanceId,
      projectId: "opaque-project-id",
      sessionId: "ses_123",
    });
    await registerRoute(socket, route, "backend", "Implement auth");

    const published = waitForMessage(socket);
    socket.send(
      JSON.stringify({
        ...envelope("notification.publish"),
        payload: {
          notification: {
            kind: "session.completed",
            eventId: "event_1",
            route,
            locale: "en",
            projectLabel: "backend",
            sessionLabel: "Implement auth",
            occurredAt: new Date(1_000).toISOString(),
          },
        },
      }),
    );

    expect(await published).toMatchObject({
      type: "notification.published",
      payload: { eventId: "event_1", status: "queued" },
    });
    await waitUntil(() => sent.length === 1);
    expect(sent[0]).toMatchObject({
      chatId: "123456789",
      parseMode: "HTML",
      disableNotification: true,
    });
    expect(broker.database.getMessageRoute("123456789", 77)).toMatchObject({
      kind: "session_prompt",
      route,
      status: "active",
    });

    const command = waitForMessage(socket);
    updates.push(messageReply({ updateId: 10, replyToMessageId: 77, text: "Continue from TG" }));
    const commandEnvelope = await command;
    expect(commandEnvelope).toMatchObject({
      type: "command",
      payload: { type: "session.prompt", route, text: "Continue from TG" },
    });
    if (commandEnvelope.type !== "command") throw new Error("expected command envelope");
    socket.send(
      JSON.stringify({
        ...envelopeForRequest("command.result", commandEnvelope.requestId),
        payload: { commandId: commandEnvelope.payload.commandId, status: "accepted" },
      }),
    );
    await waitUntil(() => sent.length === 2);
    expect(sent[1]?.text).toBe("Your response was delivered.");
  });
});

async function createBroker(
  options: Pick<
    StartBrokerOptions,
    "telegramApiFactory" | "telegramPollLongPollSeconds" | "telegramDeliveryIntervalMs"
  > = {},
): Promise<{ broker: BrokerServer; secret: string }> {
  const stateDirectory = await createTemporaryDirectory();
  const broker = await startBroker({ stateDirectory, port: 0, ...options });
  brokers.push(broker);
  const identity = await loadOrCreateStateIdentity(stateDirectory);
  return { broker, secret: identity.brokerSecret };
}

async function connectClient(port: number, secret: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/connect`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
      once: true,
    });
  });
  return socket;
}

async function registerClient(
  socket: WebSocket,
  machineId: string,
  instanceId: string,
  configFingerprint = "a".repeat(64),
  telegram?: TelegramRuntimeConfig,
): Promise<void> {
  const response = waitForMessage(socket);
  socket.send(
    JSON.stringify({
      ...envelope("register"),
      payload: {
        packageVersion: "0.0.0",
        openCodeVersion: "1.18.18",
        machineId,
        instanceId,
        configFingerprint,
        capabilities: [...BROKER_CAPABILITIES],
        ...(telegram ? { telegram } : {}),
      },
    }),
  );
  expect(await response).toMatchObject({
    type: "registered",
    payload: { capabilities: [...BROKER_CAPABILITIES] },
  });
}

function envelopeForRequest(
  type: string,
  requestId: string,
): {
  protocol: typeof PROTOCOL_VERSION;
  type: string;
  requestId: string;
  sentAt: string;
} {
  return { ...envelope(type), requestId };
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

class FakeTelegramBotApi extends TelegramBotApi {
  readonly #sent: SendMessageInput[];
  readonly #updates: TelegramUpdate[];
  #nextMessageId = 77;

  constructor(sent: SendMessageInput[], updates: TelegramUpdate[]) {
    super({ token: TOKEN, baseUrl: "https://telegram.invalid" });
    this.#sent = sent;
    this.#updates = updates;
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
    if (this.#updates.length === 0) await abortableSleep(20, input.signal);
    return this.#updates.splice(0).filter((update) => update.update_id >= input.offset);
  }

  override async sendMessage(
    input: SendMessageInput,
  ): Promise<{ messageId: number; chatId: string }> {
    this.#sent.push(input);
    return { messageId: this.#nextMessageId++, chatId: input.chatId };
  }
}

function messageReply(options: { updateId: number; replyToMessageId: number; text: string }) {
  return {
    update_id: options.updateId,
    message: {
      message_id: options.updateId + 1_000,
      from: { id: 123456789, is_bot: false, first_name: "User" },
      chat: { id: 123456789, type: "private" as const },
      date: 1_700_000_000,
      text: options.text,
      reply_to_message: {
        message_id: options.replyToMessageId,
        chat: { id: 123456789, type: "private" as const },
      },
    },
  } satisfies TelegramUpdate;
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

async function registerRoute(
  socket: WebSocket,
  route: RouteKey,
  projectLabel: string,
  sessionLabel: string,
): Promise<void> {
  const response = waitForMessage(socket);
  socket.send(
    JSON.stringify({
      ...envelope("route.register"),
      payload: { route, projectLabel, sessionLabel },
    }),
  );
  expect(await response).toMatchObject({ type: "route.registered", payload: { route } });
}

async function waitForMessage(socket: WebSocket): Promise<BrokerEnvelope> {
  return await new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          resolve(BrokerEnvelopeSchema.parse(JSON.parse(String(event.data))));
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
  });
}

async function waitForClose(socket: WebSocket): Promise<CloseEvent> {
  return await new Promise((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(10);
  }
}

function envelope(type: string): {
  protocol: typeof PROTOCOL_VERSION;
  type: string;
  requestId: string;
  sentAt: string;
} {
  return {
    protocol: PROTOCOL_VERSION,
    type,
    requestId: crypto.randomUUID(),
    sentAt: new Date().toISOString(),
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-telegram-broker-"));
  temporaryDirectories.push(directory);
  return directory;
}
