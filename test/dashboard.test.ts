import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrokerServer, startBroker } from "../src/broker/server";

describe("Web Dashboard", () => {
  let stateDirectory: string;
  let broker: BrokerServer;

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "opencode-dashboard-test-"));
    broker = await startBroker({
      stateDirectory,
      port: 0,
      bindHost: "127.0.0.1",
    });
  });

  afterAll(async () => {
    if (broker) {
      await broker.stop();
    }
    await rm(stateDirectory, { recursive: true, force: true });
  });

  test("serves dashboard HTML on / and /dashboard", async () => {
    const rootRes = await fetch(`http://127.0.0.1:${broker.port}/`);
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("content-type")).toContain("text/html");
    const rootHtml = await rootRes.text();
    expect(rootHtml).toContain("OpenCode Commander");
    expect(rootHtml).toContain("Live Dashboard");

    const dashRes = await fetch(`http://127.0.0.1:${broker.port}/dashboard`);
    expect(dashRes.status).toBe(200);
    const dashHtml = await dashRes.text();
    expect(dashHtml).toContain("拓撲總覽");
  });

  test("returns cluster summary via /v1/api/dashboard/summary", async () => {
    const res = await fetch(`http://127.0.0.1:${broker.port}/v1/api/dashboard/summary`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      service: string;
      version: string;
      connectionsCount: number;
      machines: unknown[];
      activeSessions: unknown[];
      voice?: { provider: string };
    };
    expect(data.service).toBe("opencode-telegram-link");
    expect(data.version).toBe("3.0.0");
    expect(data.connectionsCount).toBe(0);
    expect(Array.isArray(data.machines)).toBe(true);
    expect(Array.isArray(data.activeSessions)).toBe(true);
    expect(data.voice).toBeDefined();
  });

  test("handles dispatch validation when no targets are online", async () => {
    const res = await fetch(`http://127.0.0.1:${broker.port}/v1/api/dashboard/dispatch`, {
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
    const res = await fetch(`http://127.0.0.1:${broker.port}/v1/api/dashboard/cancel`, {
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

  test("handles test-voice missing credentials validation", async () => {
    const res = await fetch(`http://127.0.0.1:${broker.port}/v1/api/dashboard/test-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "cloudflare",
        apiKey: "cfut_test",
      }),
    });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { success: boolean; error: string };
    expect(data.success).toBe(false);
    expect(data.error).toContain("Account ID");
  });

  test("saves settings via /v1/api/dashboard/settings", async () => {
    const res = await fetch(`http://127.0.0.1:${broker.port}/v1/api/dashboard/settings`, {
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
