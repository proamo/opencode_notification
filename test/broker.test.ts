import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrokerPortConflictError,
  type BrokerServer,
  startBroker,
  startOrReuseBroker,
} from "../src/broker";
import {
  BROKER_CAPABILITIES,
  type BrokerEnvelope,
  BrokerEnvelopeSchema,
  PROTOCOL_VERSION,
  type RouteKey,
} from "../src/protocol";
import { createRouteKey, loadOrCreateStateIdentity } from "../src/state";

const temporaryDirectories: string[] = [];
const brokers: BrokerServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.stop()));
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
    expect(broker.registry.resolve(previous)).toBeUndefined();
    expect(broker.registry.resolve(current)).toBeDefined();
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
});

async function createBroker(): Promise<{ broker: BrokerServer; secret: string }> {
  const stateDirectory = await createTemporaryDirectory();
  const broker = await startBroker({ stateDirectory, port: 0 });
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
        capabilities: [...BROKER_CAPABILITIES],
      },
    }),
  );
  expect(await response).toMatchObject({
    type: "registered",
    payload: { machineId, capabilities: [...BROKER_CAPABILITIES] },
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
