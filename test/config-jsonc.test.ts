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
      "items": [
        1,
        2,
      ],
    }`;

    const parsed = parseJsonc<Record<string, unknown>>(raw);
    expect(parsed.name).toBe("test-project");
    expect(parsed.url).toBe("https://example.com/api//not-a-comment/*keep*/");
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
});
