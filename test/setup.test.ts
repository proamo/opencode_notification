import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverOpenCodeConfigFiles,
  injectOpenCodeConfig,
  removeOpenCodeConfig,
} from "../src/opencode";
import { runGuidedSetup, runInteractiveSetup, runSetupCli, SetupError } from "../src/setup";
import { runInteractiveUninstall } from "../src/uninstall";

const TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz_ABCD";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("guided Telegram setup", () => {
  test("validates explicit identities and persists the bot token privately", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];

    const result = await runGuidedSetup({
      botToken: TOKEN,
      userId: "123456789",
      chatId: "123456789",
      locale: "zh-TW",
      stateDirectory,
      fetch: telegramFetch(requests, {
        getMe: bot(42, "user_owned_bot"),
      }),
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready setup");
    expect(result.bot).toEqual({ id: 42, username: "user_owned_bot" });
    expect(result.config).toMatchObject({
      locale: "zh-TW",
      telegram: { tokenFile: join(stateDirectory, "telegram-bot-token") },
    });
    expect(result.config.telegram).not.toHaveProperty("botToken");
    expect(await readFile(result.tokenFile, "utf8")).toBe(`${TOKEN}\n`);
    expect(requests).toEqual([{ method: "getMe", body: {} }]);
  });

  test("fails closed when a required Telegram identity is missing without exposing credentials", async () => {
    const stateDirectory = await createTemporaryDirectory();

    const error = await runGuidedSetup({
      botToken: TOKEN,
      userId: "123456789",
      stateDirectory,
      fetch: telegramFetch([], { getMe: bot(42) }),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(SetupError);
    expect(error).toMatchObject({ code: "SETUP_IDENTITY_MISSING" });
    expect(String(error.message)).not.toContain(TOKEN);
    expect(await Bun.file(join(stateDirectory, "telegram-bot-token")).exists()).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "fails closed when setup state permissions are insecure",
    async () => {
      const stateDirectory = await createTemporaryDirectory();
      await chmod(stateDirectory, 0o777);

      const error = await runGuidedSetup({
        botToken: TOKEN,
        userId: "123456789",
        chatId: "123456789",
        stateDirectory,
        fetch: telegramFetch([], { getMe: bot(42) }),
      }).catch((caught) => caught);

      expect(error).toBeInstanceOf(SetupError);
      expect(error).toMatchObject({ code: "SETUP_PERMISSIONS_UNSAFE" });
      expect(String(error.message)).not.toContain(TOKEN);
    },
  );

  test("pairs a private Telegram chat only after local nonce confirmation", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const confirmed: Array<{ userId: string; chatId: string; updateId: number }> = [];

    const result = await runGuidedSetup({
      botToken: TOKEN,
      stateDirectory,
      fetch: telegramFetch(requests, {
        getMe: bot(42),
        getUpdates: [
          messageUpdate(5, "wrong nonce", 123456789, "private"),
          messageUpdate(6, "pair-nonce", 222222222, "group"),
          messageUpdate(7, "pair-nonce", 123456789, "private"),
        ],
      }),
      pairing: {
        enabled: true,
        nonce: "pair-nonce",
        pollTimeoutSeconds: 0,
        confirm: (candidate) => {
          confirmed.push(candidate);
          return true;
        },
      },
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready setup");
    expect(result.config.telegram?.userId).toBe("123456789");
    expect(result.config.telegram?.chatId).toBe("123456789");
    expect(result.pairing).toEqual({ userId: "123456789", chatId: "123456789", updateId: 7 });
    expect(confirmed).toEqual([{ userId: "123456789", chatId: "123456789", updateId: 7 }]);
    expect(requests.map((request) => request.method)).toEqual(["getMe", "getUpdates"]);
    expect(await Bun.file(result.tokenFile).exists()).toBe(true);
  });

  test("requires local confirmation before persisting a paired identity", async () => {
    const stateDirectory = await createTemporaryDirectory();

    const result = await runGuidedSetup({
      botToken: TOKEN,
      stateDirectory,
      now: () => 1_000,
      fetch: telegramFetch([], {
        getMe: bot(42),
        getUpdates: [messageUpdate(8, "pair-nonce", 123456789, "private")],
      }),
      pairing: { enabled: true, nonce: "pair-nonce", expiresInMs: 60_000, pollTimeoutSeconds: 0 },
    });

    expect(result).toEqual({
      status: "confirmation_required",
      bot: { id: 42 },
      nonce: "pair-nonce",
      expiresAt: 61_000,
      pairing: { userId: "123456789", chatId: "123456789", updateId: 8 },
    });
    expect(await Bun.file(join(stateDirectory, "telegram-bot-token")).exists()).toBe(false);
  });

  test("fails fast when pairing has no displayable nonce", async () => {
    const stateDirectory = await createTemporaryDirectory();

    const error = await runGuidedSetup({
      botToken: TOKEN,
      stateDirectory,
      fetch: telegramFetch([], { getMe: bot(42) }),
      pairing: { enabled: true },
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(SetupError);
    expect(error).toMatchObject({ code: "PAIRING_NONCE_REQUIRED" });
    expect(await Bun.file(join(stateDirectory, "telegram-bot-token")).exists()).toBe(false);
  });

  test("CLI pairing prints the nonce before local confirmation", async () => {
    const stateDirectory = await createTemporaryDirectory();
    let stdout = "";
    let stderr = "";

    const status = await runSetupCli({
      argv: ["--pair", "--nonce", "cli-nonce", "--state-dir", stateDirectory],
      env: { OPENCODE_TELEGRAM_BOT_TOKEN: TOKEN },
      stdout: {
        write: (chunk) => {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += String(chunk);
          return true;
        },
      },
      stdin: inputLines(["YES\n"]),
      fetch: telegramFetch([], {
        getMe: bot(42),
        getUpdates: [messageUpdate(9, "cli-nonce", 123456789, "private")],
      }),
    });

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("cli-nonce");
    expect(stdout).toContain("Type YES to persist this identity");
    expect(stdout).toContain("Notifier is ready for a test notification.");
    expect(await Bun.file(join(stateDirectory, "telegram-bot-token")).exists()).toBe(true);
  });
});

describe("interactive setup wizard", () => {
  test("runs full interactive setup flow in Traditional Chinese", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const workspaceDirectory = await createTemporaryDirectory();
    const configFile = join(workspaceDirectory, "opencode.json");
    await writeFile(configFile, JSON.stringify({ version: "1.0" }, null, 2), "utf8");

    let stdout = "";
    let stderr = "";
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];

    // Responses:
    // 1. Language: 1 (zh-TW)
    // 2. Role: 1 (Gateway Mode)
    // 3. Host label: codeCenter
    // 4. Mode: 1 (Native Mode)
    // 5. Token: invalid_token then valid TOKEN
    // 6. Confirm pairing: Y
    // 7. Update OpenCode config: Y
    // 8. Send test notification: Y
    const inputs = [
      "1\n",
      "1\n",
      "codeCenter\n",
      "1\n",
      "invalid_token\n",
      `${TOKEN}\n`,
      "Y\n",
      "Y\n",
      "Y\n",
    ];

    const status = await runInteractiveSetup({
      stateDirectory,
      cwd: workspaceDirectory,
      stdin: inputLines(inputs),
      stdout: {
        write: (chunk) => {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += String(chunk);
          return true;
        },
      },
      fetch: (async (url, init) => {
        const method = String(url).split("/").pop();
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push({ method: method ?? "", body });
        if (method === "getMe") return ok(bot(42, "test_bot"));
        if (method === "getUpdates") {
          // Find the nonce from the stdout
          const match = stdout.match(/👉\s+([A-Za-z0-9_-]+)/);
          const nonce = match?.[1] ?? "pair-nonce";
          return ok([messageUpdate(1, nonce, 987654321, "private")]);
        }
        if (method === "sendMessage") {
          return ok({
            message_id: 101,
            chat: { id: 987654321, type: "private" },
            date: 1_700_000_000,
          });
        }
        return failed(404);
      }) as typeof fetch,
    });

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("OpenCode Telegram Notifier — Setup Wizard");
    expect(stdout).toContain("已辨識 Bot: @test_bot (ID: 42)");
    expect(stdout).toContain("收到驗證訊息！來自 Telegram 用戶 (ID: 987654321");
    expect(stdout).toContain("安全 Token 檔案已儲存");
    expect(stdout).toContain("OpenCode 設定檔已更新");
    expect(stdout).toContain("已成功發送測試通知到您的 Telegram！");
    expect(stdout).toContain("安裝設定完成！");

    // Verify token file
    const tokenFile = join(stateDirectory, "telegram-bot-token");
    expect(await readFile(tokenFile, "utf8")).toBe(`${TOKEN}\n`);

    // Verify opencode.json
    const updatedConfig = JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>;
    expect(updatedConfig.plugins).toContain("opencode-telegram-link");
    expect(updatedConfig.plugin).toMatchObject({
      "opencode-telegram-link": {
        locale: "zh-TW",
        telegram: {
          tokenFile,
          userId: "987654321",
          chatId: "987654321",
        },
      },
    });

    // Verify backup created
    expect(await Bun.file(`${configFile}.bak`).exists()).toBe(true);
  });

  test("runs interactive setup in English and respects skip options", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const workspaceDirectory = await createTemporaryDirectory();

    let stdout = "";
    let stderr = "";

    const inputs = [
      "2\n", // English
      "1\n", // Gateway mode
      "dev-laptop\n", // Host label
      "2\n", // Docker mode
      `${TOKEN}\n`,
      "Y\n", // Confirm pairing
      "n\n", // Skip OpenCode auto-config
      "n\n", // Skip Docker auto-start
      "n\n", // Skip test notification
    ];

    const status = await runInteractiveSetup({
      stateDirectory,
      cwd: workspaceDirectory,
      stdin: inputLines(inputs),
      stdout: {
        write: (chunk) => {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += String(chunk);
          return true;
        },
      },
      fetch: (async (url, _init) => {
        const method = String(url).split("/").pop();
        if (method === "getMe") return ok(bot(42, "test_bot"));
        if (method === "getUpdates") {
          const match = stdout.match(/👉\s+([A-Za-z0-9_-]+)/);
          const nonce = match?.[1] ?? "pair-nonce";
          return ok([messageUpdate(1, nonce, 987654321, "private")]);
        }
        return failed(404);
      }) as typeof fetch,
    });

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("OpenCode Telegram Notifier — Setup Wizard");
    expect(stdout).toContain("Connected! Identified Bot: @test_bot");
    expect(stdout).toContain("Received pairing message! Telegram User (ID: 987654321");
    expect(stdout).toContain("Please add the following configuration to your opencode.json");
    expect(stdout).toContain("Setup completed!");
  });
});

describe("OpenCode config helper", () => {
  test("discovers existing config in workspace directory", async () => {
    const workspace = await createTemporaryDirectory();
    const configFile = join(workspace, "opencode.json");
    await writeFile(configFile, "{}", "utf8");

    const configs = await discoverOpenCodeConfigFiles(workspace);
    expect(configs.some((c) => c.path === configFile && c.exists)).toBe(true);
  });

  test("injects plugin config and creates backup", async () => {
    const workspace = await createTemporaryDirectory();
    const configFile = join(workspace, "opencode.json");
    await writeFile(configFile, JSON.stringify({ existingSetting: true }), "utf8");

    const result = await injectOpenCodeConfig(configFile, {
      mode: "local",
      role: "gateway",
      locale: "zh-TW",
      telegram: {
        tokenFile: "/path/to/token",
        userId: "123",
        chatId: "123",
      },
      notifications: {
        completion: true,
        error: true,
        question: true,
        permission: true,
        includeChildLifecycle: false,
        completionDebounceMs: 1500,
        pluginBufferSize: 100,
      },
      broker: {
        host: "127.0.0.1",
        port: 42617,
      },
      interaction: {
        sessionPromptTtlMinutes: 1440,
        questionTtlMinutes: 30,
      },
    });

    expect(result.targetPath).toBe(configFile);
    expect(result.backupPath).toBe(`${configFile}.bak`);

    const parsed = JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>;
    expect(parsed.existingSetting).toBe(true);
    expect(parsed.plugins).toEqual(["opencode-telegram-link"]);
    expect(parsed.plugin).toMatchObject({
      "opencode-telegram-link": {
        locale: "zh-TW",
        telegram: { userId: "123", chatId: "123" },
      },
    });
  });

  test("removes plugin config and leaves other settings untouched", async () => {
    const workspace = await createTemporaryDirectory();
    const configFile = join(workspace, "opencode.json");
    await writeFile(
      configFile,
      JSON.stringify({
        otherPlugin: true,
        plugins: ["other-plugin", "opencode-telegram-link"],
        plugin: {
          "other-plugin": { enabled: true },
          "opencode-telegram-link": { mode: "local" },
        },
      }),
      "utf8",
    );

    const result = await removeOpenCodeConfig(configFile);
    expect(result.modified).toBe(true);
    expect(result.backupPath).toBe(`${configFile}.bak`);

    const parsed = JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>;
    expect(parsed.otherPlugin).toBe(true);
    expect(parsed.plugins).toEqual(["other-plugin"]);
    expect(parsed.plugin).toEqual({ "other-plugin": { enabled: true } });
  });
});

describe("interactive uninstaller wizard", () => {
  test("runs full uninstall flow and cleans up state, config, and tokens", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const workspace = await createTemporaryDirectory();
    const configFile = join(workspace, "opencode.json");
    const tokenFile = join(stateDirectory, "telegram-bot-token");

    await writeFile(tokenFile, `${TOKEN}\n`, "utf8");
    await writeFile(
      configFile,
      JSON.stringify({
        plugins: ["opencode-telegram-link"],
        plugin: { "opencode-telegram-link": { mode: "local" } },
      }),
      "utf8",
    );

    let stdout = "";
    let stderr = "";

    // Responses:
    // 1. Language: 1 (zh-TW)
    // 2. Confirm uninstall: Y
    // 3. Clean OpenCode configs: Y
    // 4. Clean SQLite state: Y
    // 5. Delete Token file: Y
    // 6. Delete entire state directory: Y
    const inputs = ["1\n", "Y\n", "Y\n", "Y\n", "Y\n", "Y\n"];

    const status = await runInteractiveUninstall({
      stateDirectory,
      cwd: workspace,
      stdin: inputLines(inputs),
      stdout: {
        write: (chunk) => {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += String(chunk);
          return true;
        },
      },
    });

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("OpenCode Telegram Notifier — Uninstaller");
    expect(stdout).toContain("已從");
    expect(stdout).toContain("移除外掛設定");
    expect(stdout).toContain("Token 檔案已安全刪除");
    expect(stdout).toContain("已成功移除！");

    // Verify opencode.json cleaned
    const parsed = JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>;
    expect(parsed.plugins).toEqual([]);
    expect(parsed.plugin).toEqual({});

    // Verify token deleted
    expect(await Bun.file(tokenFile).exists()).toBe(false);
  });

  test("runs uninstall flow on a Node Agent machine without error", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const workspace = await createTemporaryDirectory();
    const configFile = join(workspace, "opencode.json");

    await writeFile(
      configFile,
      JSON.stringify({
        plugins: ["opencode-telegram-link"],
        plugin: {
          "opencode-telegram-link": {
            mode: "local",
            role: "node",
            hostLabel: "laptop",
            gateway: { url: "ws://1.2.3.4:42617", secret: "sec" },
          },
        },
      }),
      "utf8",
    );

    let stdout = "";
    let stderr = "";

    // Responses:
    // 1. Language: 2 (English)
    // 2. Confirm uninstall: Y
    // 3. Clean OpenCode configs: Y
    // 4. Clean SQLite state: Y
    // 5. Delete Token file: y (even if not present)
    // 6. Delete state directory: y
    const inputs = ["2\n", "Y\n", "Y\n", "Y\n", "Y\n", "Y\n"];

    const status = await runInteractiveUninstall({
      stateDirectory,
      cwd: workspace,
      stdin: inputLines(inputs),
      stdout: {
        write: (chunk) => {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += String(chunk);
          return true;
        },
      },
    });

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("OpenCode Telegram Notifier — Uninstaller");
    expect(stdout).toContain("Removed plugin config");
    expect(stdout).toContain("successfully uninstalled!");

    // Verify opencode.json cleaned
    const parsed = JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>;
    expect(parsed.plugins).toEqual([]);
    expect(parsed.plugin).toEqual({});
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-telegram-setup-"));
  temporaryDirectories.push(directory);
  return directory;
}

function telegramFetch(
  requests: Array<{ method: string; body: Record<string, unknown> }>,
  fixtures: { getMe: Record<string, unknown>; getUpdates?: Record<string, unknown>[] },
): typeof fetch {
  return (async (url, init) => {
    const method = String(url).split("/").pop();
    if (!method) throw new Error("missing Telegram method");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ method, body });
    if (method === "getMe") return ok(fixtures.getMe);
    if (method === "getUpdates") return ok(fixtures.getUpdates ?? []);
    return failed(404);
  }) as typeof fetch;
}

async function* inputLines(values: string[]): AsyncIterable<string> {
  for (const value of values) {
    yield value;
  }
}

function ok(result: unknown): Response {
  return Response.json({ ok: true, result });
}

function failed(status: number): Response {
  return Response.json({ ok: false, error_code: status, description: "failed" }, { status });
}

function bot(id: number, username?: string): Record<string, unknown> {
  return { id, is_bot: true, first_name: "Notifier", ...(username ? { username } : {}) };
}

function messageUpdate(
  updateId: number,
  text: string,
  userId: number,
  chatType: "private" | "group",
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      from: { id: userId, is_bot: false, first_name: "User" },
      chat: { id: chatType === "private" ? userId : -100123456789, type: chatType },
      date: 1_700_000_000,
      text,
    },
  };
}
