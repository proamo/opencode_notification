import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotifierConfigSchema } from "../src/config";
import {
  injectOpenCodeConfig,
  loadResolvedNotifierConfig,
  parseJsonc,
} from "../src/opencode/config-helper";

describe("JSONC Parsing & Config Injection Security", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "opencode-config-test-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("parseJsonc strips comments and trailing commas without breaking strings", () => {
    const raw = `{
      // Single line comment
      "name": "test-project",
      /* Multi line
         comment */
      "url": "https://example.com/api//not-a-comment/*keep*/",
      "note": "keep ,} and ,] exactly",
      "items": [
        1,
        2,
      ],
    }`;

    const parsed = parseJsonc<Record<string, unknown>>(raw);
    expect(parsed.name).toBe("test-project");
    expect(parsed.url).toBe("https://example.com/api//not-a-comment/*keep*/");
    expect(parsed.note).toBe("keep ,} and ,] exactly");
    expect(parsed.items).toEqual([1, 2]);
  });

  test("injectOpenCodeConfig writes [plugin, options] tuple when plugin is array", async () => {
    const configPath = join(tempDir, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          plugin: ["existing-plugin"],
        },
        null,
        2,
      ),
      "utf8",
    );

    const nodeConfig = NotifierConfigSchema.parse({
      mode: "local",
      role: "node",
      hostLabel: "GPU-Worker-1",
      locale: "zh-TW",
      gateway: {
        url: "ws://192.168.1.50:42617/v1/connect",
        secret: "test_gateway_secret_123",
      },
      notifications: {
        completion: true,
        error: true,
        question: true,
        permission: true,
      },
    });

    await injectOpenCodeConfig(configPath, nodeConfig);

    const writtenContent = await readFile(configPath, "utf8");
    const parsed = JSON.parse(writtenContent);

    expect(Array.isArray(parsed.plugin)).toBe(true);
    expect(parsed.plugin.length).toBe(2);

    const injectedTuple = parsed.plugin.find(
      (p: unknown) => Array.isArray(p) && p[0] === "opencode-telegram-link",
    );
    expect(injectedTuple).toBeDefined();
    expect(injectedTuple[1].role).toBe("node");
    expect(injectedTuple[1].hostLabel).toBe("GPU-Worker-1");
    expect(injectedTuple[1].gateway.url).toBe("ws://192.168.1.50:42617/v1/connect");

    // Test loadResolvedNotifierConfig round-trip
    const loaded = await loadResolvedNotifierConfig(undefined, tempDir);
    expect(loaded).toBeDefined();
    expect(loaded?.role).toBe("node");
    expect(loaded?.hostLabel).toBe("GPU-Worker-1");
    expect(loaded?.gateway?.url).toBe("ws://192.168.1.50:42617/v1/connect");
  });

  test("injectOpenCodeConfig fails safe and does not overwrite corrupted config", async () => {
    const corruptedPath = join(tempDir, "corrupted.jsonc");
    const badContent = `{\n  "broken": unquoted value\n}`;
    await writeFile(corruptedPath, badContent, "utf8");

    const sampleConfig = NotifierConfigSchema.parse({
      mode: "local",
      role: "gateway",
      locale: "auto",
      telegram: {
        tokenFile: "/path/token",
        userId: "123456789",
        chatId: "123456789",
      },
      notifications: {
        completion: true,
        error: true,
        question: true,
        permission: true,
      },
    });

    // Must throw error rather than silently overwriting with empty {}
    expect(injectOpenCodeConfig(corruptedPath, sampleConfig)).rejects.toThrow("Failed to parse");

    const contentAfter = await readFile(corruptedPath, "utf8");
    expect(contentAfter).toBe(badContent);
  });

  test("injectOpenCodeConfig preserves existing custom options when updating plugin tuple", async () => {
    const configPath = join(tempDir, "existing-options.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          plugin: [
            [
              "opencode-telegram-link",
              {
                role: "gateway",
                interaction: { allowAll: true },
                voice: { model: "whisper-large" },
                broker: { idleTimeoutMs: 120000 },
                notifications: {
                  includeChildLifecycle: true,
                  completionDebounceMs: 5000,
                  pluginBufferSize: 50,
                },
                customOption: "preserved-value",
              },
            ],
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const updateConfig = NotifierConfigSchema.parse({
      mode: "local",
      role: "node",
      hostLabel: "Updated-Worker",
      locale: "zh-TW",
      gateway: {
        url: "ws://10.0.0.1:42617/v1/connect",
        secret: "updated_secret",
      },
      notifications: {
        completion: true,
        error: false,
        question: true,
        permission: true,
      },
    });

    await injectOpenCodeConfig(configPath, updateConfig);

    const writtenContent = await readFile(configPath, "utf8");
    const parsed = JSON.parse(writtenContent);
    const tuple = parsed.plugin[0];
    expect(tuple[0]).toBe("opencode-telegram-link");

    const options = tuple[1];
    // Updated managed fields
    expect(options.role).toBe("node");
    expect(options.hostLabel).toBe("Updated-Worker");
    expect(options.gateway.url).toBe("ws://10.0.0.1:42617/v1/connect");
    expect(options.notifications.error).toBe(false);

    // Preserved custom fields
    expect(options.interaction).toEqual({ allowAll: true });
    expect(options.voice).toEqual({ model: "whisper-large" });
    expect(options.broker).toEqual({ idleTimeoutMs: 120000 });
    expect(options.notifications.includeChildLifecycle).toBe(true);
    expect(options.notifications.completionDebounceMs).toBe(5000);
    expect(options.notifications.pluginBufferSize).toBe(50);
    expect(options.customOption).toBe("preserved-value");
  });

  test("injectOpenCodeConfig removes stale role credentials when switching role from node to gateway", async () => {
    const configPath = join(tempDir, "switch-role.json");
    // Start with Node configuration (which has gateway.secret and hostLabel)
    await writeFile(
      configPath,
      JSON.stringify(
        {
          plugin: [
            [
              "opencode-telegram-link",
              {
                role: "node",
                hostLabel: "Old-Node-Host",
                gateway: {
                  url: "ws://192.168.1.100:42617/v1/connect",
                  secret: "old_node_secret_123",
                },
                customSetting: "keep-me",
              },
            ],
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    // Switch role to gateway (with Telegram credentials)
    const gatewayConfig = NotifierConfigSchema.parse({
      mode: "local",
      role: "gateway",
      locale: "en",
      telegram: {
        tokenFile: "/path/to/token",
        userId: "999888777",
        chatId: "999888777",
      },
      notifications: {
        completion: true,
        error: true,
        question: true,
        permission: true,
      },
    });

    await injectOpenCodeConfig(configPath, gatewayConfig);

    const writtenContent = await readFile(configPath, "utf8");
    const parsed = JSON.parse(writtenContent);
    const options = parsed.plugin[0][1];

    expect(options.role).toBe("gateway");
    expect(options.telegram).toEqual({
      tokenFile: "/path/to/token",
      userId: "999888777",
      chatId: "999888777",
    });

    // Stale node-only fields must be cleaned up
    expect(options.gateway).toBeUndefined();
    expect(options.hostLabel).toBeUndefined();

    // Custom option must remain
    expect(options.customSetting).toBe("keep-me");
  });
});
