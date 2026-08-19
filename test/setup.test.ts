import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGuidedSetup, runSetupCli, SetupError } from "../src/setup";

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
    expect((await lstat(result.tokenFile)).mode & 0o077).toBe(0);
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
    expect(result.config.telegram.userId).toBe("123456789");
    expect(result.config.telegram.chatId).toBe("123456789");
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
      stdin: inputLine("YES\n"),
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

async function* inputLine(value: string): AsyncIterable<string> {
  yield value;
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
