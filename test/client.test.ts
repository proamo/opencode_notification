import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrokerServer, probeBroker, startBroker } from "../src/broker";
import { BrokerClient, type BrokerClientOptions } from "../src/plugin/client";
import type { BrokerCommand } from "../src/protocol";
import { discoveryRecordPath, loadOrCreateStateIdentity } from "../src/state";

const temporaryDirectories: string[] = [];
const brokers: BrokerServer[] = [];
const clients: BrokerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  await Promise.all(brokers.splice(0).map((broker) => broker.stop()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("BrokerClient lifecycle", () => {
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
    const stale = await brokers[0].sendCommand({
      type: "session.prompt",
      commandId: crypto.randomUUID(),
      route: { ...route, routeGeneration: crypto.randomUUID() },
      text: "Must not reroute",
    });

    expect(result.status).toBe("accepted");
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ type: "session.prompt", route, text: "Continue safely" });
    expect(stale).toMatchObject({ status: "stale", reason: "route is offline" });
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
  options: Pick<BrokerClientOptions, "onCommand"> = {},
): BrokerClient {
  return new BrokerClient({
    stateDirectory,
    port,
    packageVersion: "0.0.0",
    openCodeVersion: "1.18.18",
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 1_000,
    heartbeatIntervalMs: 20,
    reconnectMinDelayMs: 5,
    reconnectMaxDelayMs: 20,
    random: () => 0,
    ...options,
    spawnBroker: async () => {
      const broker = await startBroker({ stateDirectory, port, idleTimeoutMs: 5_000 });
      brokers.push(broker);
    },
  });
}

function routeIntent() {
  return {
    projectId: "opaque-project-id",
    sessionId: "ses_123",
    projectLabel: "backend",
    sessionLabel: "Implement auth",
  };
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
