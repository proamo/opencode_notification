import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigValidationError,
  computeNotifierConfigFingerprint,
  NotifierConfigSchema,
  readNotifierBotToken,
  sanitizeConfigError,
} from "../src/config";

const validConfig = {
  telegram: {
    tokenFile: "/home/user/.config/opencode/telegram-token",
    userId: "123456789",
    chatId: "123456789",
  },
};

describe("NotifierConfigSchema", () => {
  test("applies safe local defaults", () => {
    const result = NotifierConfigSchema.parse(validConfig);

    expect(result.mode).toBe("local");
    expect(result.locale).toBe("auto");
    expect(result.notifications).toEqual({
      completion: true,
      error: true,
      question: true,
      permission: true,
      includeChildLifecycle: false,
      completionDebounceMs: 1_500,
      pluginBufferSize: 100,
    });
    expect(result.broker).toEqual({ host: "127.0.0.1", port: 42617 });
    expect(result.interaction.questionTtlMinutes).toBe(30);
  });

  test("requires exactly one token source", () => {
    expect(
      NotifierConfigSchema.safeParse({
        ...validConfig,
        telegram: {
          ...validConfig.telegram,
          botToken: "1234567890:abcdefghijklmnopqrstuvwxyz",
        },
      }).success,
    ).toBe(false);

    expect(
      NotifierConfigSchema.safeParse({
        telegram: { userId: "123456789", chatId: "123456789" },
      }).success,
    ).toBe(false);
  });

  test("rejects group chats and mismatched private chats", () => {
    expect(
      NotifierConfigSchema.safeParse({
        telegram: { ...validConfig.telegram, chatId: "-100123456789" },
      }).success,
    ).toBe(false);

    expect(
      NotifierConfigSchema.safeParse({
        telegram: { ...validConfig.telegram, chatId: "987654321" },
      }).success,
    ).toBe(false);
  });

  test("rejects non-loopback V1 modes and invalid bounds", () => {
    expect(NotifierConfigSchema.safeParse({ ...validConfig, mode: "remote" }).success).toBe(false);
    expect(
      NotifierConfigSchema.safeParse({ ...validConfig, broker: { host: "0.0.0.0" } }).success,
    ).toBe(false);
    expect(NotifierConfigSchema.safeParse({ ...validConfig, broker: { port: 80 } }).success).toBe(
      false,
    );
    expect(
      NotifierConfigSchema.safeParse({
        ...validConfig,
        notifications: { completionDebounceMs: 60_001 },
      }).success,
    ).toBe(false);
    expect(
      NotifierConfigSchema.safeParse({
        ...validConfig,
        notifications: { pluginBufferSize: 0 },
      }).success,
    ).toBe(false);
  });

  test("loads only private regular token files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-telegram-config-"));
    try {
      const tokenFile = join(directory, "token");
      await writeFile(tokenFile, "123456789:abcdefghijklmnopqrstuvwxyz_ABCD\n", { mode: 0o600 });
      const config = NotifierConfigSchema.parse({
        telegram: { tokenFile, userId: "123456789", chatId: "123456789" },
      });

      await expect(readNotifierBotToken(config)).resolves.toBe(
        "123456789:abcdefghijklmnopqrstuvwxyz_ABCD",
      );

      await chmod(tokenFile, 0o644);
      const error = await readNotifierBotToken(config).catch((caught) => caught);
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error).toMatchObject({ code: "TOKEN_FILE_PERMISSIONS_UNSAFE" });
      expect(String(error.message)).not.toContain(tokenFile);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("creates stable redacted fingerprints for semantic configuration", () => {
    const first = NotifierConfigSchema.parse({
      telegram: {
        botToken: "123456789:abcdefghijklmnopqrstuvwxyz_ABCD",
        userId: "123456789",
        chatId: "123456789",
      },
    });
    const sameSemantics = NotifierConfigSchema.parse({
      telegram: {
        botToken: "123456789:DIFFERENTabcdefghijklmnopqrstuvwxyz",
        userId: "123456789",
        chatId: "123456789",
      },
    });
    const changedPolicy = NotifierConfigSchema.parse({
      telegram: {
        botToken: "123456789:abcdefghijklmnopqrstuvwxyz_ABCD",
        userId: "987654321",
        chatId: "987654321",
      },
    });

    expect(computeNotifierConfigFingerprint(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeNotifierConfigFingerprint(first)).toBe(
      computeNotifierConfigFingerprint(sameSemantics),
    );
    expect(computeNotifierConfigFingerprint(first)).not.toBe(
      computeNotifierConfigFingerprint(changedPolicy),
    );
  });

  test("sanitizes configuration errors without exposing secrets", () => {
    const token = "123456789:abcdefghijklmnopqrstuvwxyz_ABCD";
    const parsed = NotifierConfigSchema.safeParse({
      telegram: { botToken: token, userId: "123456789", chatId: "987654321" },
    });
    if (parsed.success) throw new Error("expected invalid config");

    const message = sanitizeConfigError(parsed.error);
    expect(message).toContain("telegram.chatId");
    expect(message).not.toContain(token);
    expect(sanitizeConfigError(new Error(`bad token ${token}`))).toBe("bad token [REDACTED]");
  });
});
