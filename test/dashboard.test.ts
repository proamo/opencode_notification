import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrokerServer, startBroker } from "../src/broker/server";
import { loadOrCreateStateIdentity } from "../src/state";

describe("Web Dashboard", () => {
  let stateDirectory: string;
  let broker: BrokerServer;
  let brokerSecret: string;

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "opencode-dashboard-test-"));
    const state = await loadOrCreateStateIdentity(stateDirectory);
    brokerSecret = state.brokerSecret;
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

  test("rejects unauthenticated requests to /v1/api/dashboard/* with 401", async () => {
    const res = await fetch(`http://127.0.0.1:${broker.port}/v1/api/dashboard/summary`);
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Unauthorized");
  });

  test("returns cluster summary via /v1/api/dashboard/summary when authenticated", async () => {
    const res = await fetch(`http://127.0.0.1:${broker.port}/v1/api/dashboard/summary`, {
      headers: { Authorization: `Bearer ${brokerSecret}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      service: string;
      version: string;
      connectionsCount: number;
      machines: unknown[];
      activeSessions: unknown[];
      voice?: {
        provider: string;
        hasApiKey: boolean;
        groq?: { hasApiKey: boolean; maskedKey?: string; apiKey?: string };
        cloudflare?: { hasApiToken: boolean; maskedToken?: string; apiToken?: string };
      };
    };
    expect(data.service).toBe("opencode-telegram-link");
    expect(data.version).toBe("3.0.0");
    expect(data.connectionsCount).toBe(0);
    expect(Array.isArray(data.machines)).toBe(true);
    expect(Array.isArray(data.activeSessions)).toBe(true);
    expect(data.voice).toBeDefined();

    // Verify secrets are masked and plaintext is never leaked
    if (data.voice?.groq) {
      expect(data.voice.groq.apiKey).toBeUndefined();
    }
    if (data.voice?.cloudflare) {
      expect(data.voice.cloudflare.apiToken).toBeUndefined();
    }
  });

  test("handles dispatch validation when no targets are online", async () => {
    const res = await fetch(`http://127.0.0.1:${broker.port}/v1/api/dashboard/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${brokerSecret}`,
      },
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${brokerSecret}`,
      },
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${brokerSecret}`,
      },
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${brokerSecret}`,
      },
      body: JSON.stringify({
        voiceProvider: "groq",
        voiceApiKey: "gsk_test123",
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      success: boolean;
      settings?: {
        groq?: { hasApiKey: boolean; maskedKey?: string; apiKey?: string };
      };
    };
    expect(data.success).toBe(true);
    expect(data.settings?.groq?.hasApiKey).toBe(true);
    expect(data.settings?.groq?.maskedKey).toContain("••••");
    expect(data.settings?.groq?.apiKey).toBeUndefined();

    // Verify summary returns masked key, not plaintext
    const summaryRes = await fetch(`http://127.0.0.1:${broker.port}/v1/api/dashboard/summary`, {
      headers: { Authorization: `Bearer ${brokerSecret}` },
    });
    const summaryData = (await summaryRes.json()) as {
      voice?: { groq?: { hasApiKey: boolean; maskedKey?: string; apiKey?: string } };
    };
    expect(summaryData.voice?.groq?.hasApiKey).toBe(true);
    expect(summaryData.voice?.groq?.maskedKey).toContain("••••");
    expect(summaryData.voice?.groq?.apiKey).toBeUndefined();
  });

  test("environment variable API keys are not persisted to disk when saving settings", async () => {
    const originalEnv = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "gsk_env_secret_key_123456789";

    try {
      const saveRes = await fetch(`http://127.0.0.1:${broker.port}/v1/api/dashboard/settings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${brokerSecret}`,
        },
        body: JSON.stringify({
          sessionPromptTtlMinutes: 1440,
        }),
      });

      expect(saveRes.status).toBe(200);

      // Verify the raw json file on disk does NOT contain the environment variable key
      const diskPath = join(stateDirectory, "dashboard-settings.json");
      const diskRaw = await readFile(diskPath, "utf8");
      const diskParsed = JSON.parse(diskRaw);
      expect(diskParsed.sessionPromptTtlMinutes).toBe(1440);
      expect(diskParsed.groq?.apiKey).not.toBe("gsk_env_secret_key_123456789");
      expect(diskRaw).not.toContain("gsk_env_secret_key_123456789");
    } finally {
      if (originalEnv !== undefined) {
        process.env.GROQ_API_KEY = originalEnv;
      } else {
        delete process.env.GROQ_API_KEY;
      }
    }
  });
});
