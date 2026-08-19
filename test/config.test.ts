import { describe, expect, test } from "bun:test";
import { NotifierConfigSchema } from "../src/config";

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
    expect(result.broker.port).toBe(42617);
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
});
