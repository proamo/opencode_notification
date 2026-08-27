import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrokerServer, startBroker } from "../src/broker/server";

describe("Web Dashboard", () => {
  let stateDirectory: string;
  let broker: BrokerServer | undefined;
  const testPort = 43719;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "opencode-dashboard-test-"));
  });

  afterEach(async () => {
    if (broker) {
      await broker.stop();
      broker = undefined;
    }
    await rm(stateDirectory, { recursive: true, force: true });
  });

  test("serves dashboard HTML on / and /dashboard", async () => {
    broker = await startBroker({
      stateDirectory,
      port: testPort,
      bindHost: "127.0.0.1",
    });

    const rootRes = await fetch(`http://127.0.0.1:${testPort}/`);
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("content-type")).toContain("text/html");
    const rootHtml = await rootRes.text();
    expect(rootHtml).toContain("OpenCode Commander");
    expect(rootHtml).toContain("Live Dashboard");

    const dashRes = await fetch(`http://127.0.0.1:${testPort}/dashboard`);
    expect(dashRes.status).toBe(200);
    const dashHtml = await dashRes.text();
    expect(dashHtml).toContain("拓撲總覽");
  });

  test("returns cluster summary via /v1/api/dashboard/summary", async () => {
    broker = await startBroker({
      stateDirectory,
      port: testPort,
      bindHost: "127.0.0.1",
    });

    const res = await fetch(`http://127.0.0.1:${testPort}/v1/api/dashboard/summary`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      service: string;
      version: string;
      connectionsCount: number;
      machines: unknown[];
      activeSessions: unknown[];
    };
    expect(data.service).toBe("opencode-telegram-link");
    expect(data.version).toBe("3.0.0");
    expect(data.connectionsCount).toBe(0);
    expect(Array.isArray(data.machines)).toBe(true);
    expect(Array.isArray(data.activeSessions)).toBe(true);
  });

  test("handles dispatch validation when no targets are online", async () => {
    broker = await startBroker({
      stateDirectory,
      port: testPort,
      bindHost: "127.0.0.1",
    });

    const res = await fetch(`http://127.0.0.1:${testPort}/v1/api/dashboard/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "test dispatch prompt",
      }),
    });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { success: boolean; reason: string };
    expect(data.success).toBe(false);
  });

  test("handles cancel validation when session is not found", async () => {
    broker = await startBroker({
      stateDirectory,
      port: testPort,
      bindHost: "127.0.0.1",
    });

    const res = await fetch(`http://127.0.0.1:${testPort}/v1/api/dashboard/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "ses_nonexistent_123",
      }),
    });

    expect(res.status).toBe(404);
    const data = (await res.json()) as { success: boolean; reason: string };
    expect(data.success).toBe(false);
    expect(data.reason).toContain("not found");
  });

  test("saves settings via /v1/api/dashboard/settings", async () => {
    broker = await startBroker({
      stateDirectory,
      port: testPort,
      bindHost: "127.0.0.1",
    });

    const res = await fetch(`http://127.0.0.1:${testPort}/v1/api/dashboard/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voiceProvider: "groq",
        voiceApiKey: "gsk_test123",
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(true);
  });
});
