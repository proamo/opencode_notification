import { describe, expect, test } from "bun:test";
import { RouteRegistry } from "../src/broker/registry";
import {
  executeSlashCommand,
  isSlashCommand,
  parseSlashCommand,
  type SlashCommandContext,
} from "../src/telegram/commands";
import type { BrokerCommand, CommandResult, RouteKey } from "../src/protocol";

describe("Slash Commands System", () => {
  test("isSlashCommand recognizes valid slash commands", () => {
    expect(isSlashCommand("/help")).toBe(true);
    expect(isSlashCommand("/status")).toBe(true);
    expect(isSlashCommand("/nodes@my_bot")).toBe(true);
    expect(isSlashCommand("  /cancel 123  ")).toBe(true);
    expect(isSlashCommand("/")).toBe(false);
    expect(isSlashCommand("hello world")).toBe(false);
    expect(isSlashCommand("")).toBe(false);
    expect(isSlashCommand(undefined)).toBe(false);
  });

  test("parseSlashCommand extracts command and arguments correctly", () => {
    expect(parseSlashCommand("/help")).toEqual({ command: "help", args: [] });
    expect(parseSlashCommand("/cancel ses_abc 123")).toEqual({
      command: "cancel",
      args: ["ses_abc", "123"],
    });
    expect(parseSlashCommand("/status@MyOpenCodeBot")).toEqual({
      command: "status",
      args: [],
    });
    expect(parseSlashCommand("not a command")).toBeUndefined();
  });

  test("renders help menu in Traditional Chinese and English", async () => {
    const registry = new RouteRegistry();
    const dispatcher = { sendCommand: async () => ({ commandId: "123", status: "accepted" as const }) };

    const zhResult = await executeSlashCommand({
      text: "/help",
      locale: "zh-TW",
      registry,
      dispatcher,
    });
    expect(zhResult).toContain("OpenCode 行動指揮官");
    expect(zhResult).toContain("/status");
    expect(zhResult).toContain("/nodes");
    expect(zhResult).toContain("/sessions");
    expect(zhResult).toContain("/cancel");

    const enResult = await executeSlashCommand({
      text: "/help",
      locale: "en",
      registry,
      dispatcher,
    });
    expect(enResult).toContain("OpenCode Commander");
  });

  test("renders gateway status with uptime and memory", async () => {
    const registry = new RouteRegistry();
    const dispatcher = { sendCommand: async () => ({ commandId: "123", status: "accepted" as const }) };

    const result = await executeSlashCommand({
      text: "/status",
      locale: "zh-TW",
      registry,
      dispatcher,
      startedAt: Date.now() - 120_000,
      packageVersion: "3.0.0",
    });

    expect(result).toContain("Gateway 系統狀態");
    expect(result).toContain("v3.0.0");
    expect(result).toContain("2m");
    expect(result).toContain("Memory RSS");
  });

  test("renders connected nodes list", async () => {
    const registry = new RouteRegistry();
    const dispatcher = { sendCommand: async () => ({ commandId: "123", status: "accepted" as const }) };

    // When empty
    const emptyResult = await executeSlashCommand({
      text: "/nodes",
      locale: "zh-TW",
      registry,
      dispatcher,
    });
    expect(emptyResult).toContain("目前沒有任何在線電腦");

    // Register a mock node
    const fakeSocket = { data: { connectionId: "conn-1" }, close: () => {} } as any;
    registry.registerConnection(fakeSocket, "inst-1", "mach-12345678", "d009-win10");

    const populatedResult = await executeSlashCommand({
      text: "/nodes",
      locale: "zh-TW",
      registry,
      dispatcher,
    });
    expect(populatedResult).toContain("[d009-win10]");
    expect(populatedResult).toContain("Online");
  });

  test("renders active sessions and dispatches /cancel command", async () => {
    const registry = new RouteRegistry();
    let dispatchedCommand: BrokerCommand | undefined;
    const dispatcher = {
      sendCommand: async (cmd: BrokerCommand): Promise<CommandResult> => {
        dispatchedCommand = cmd;
        return { commandId: cmd.commandId, status: "accepted" };
      },
    };

    const machineId = crypto.randomUUID();
    const instanceId = crypto.randomUUID();
    const fakeSocket = { data: { connectionId: "conn-1" }, close: () => {} } as any;
    registry.registerConnection(fakeSocket, instanceId, machineId, "d009-win10");

    const route: RouteKey = {
      machineId,
      instanceId,
      projectId: "opaque-project-alpha-12345",
      sessionId: "ses_task_999",
      routeGeneration: crypto.randomUUID(),
    };
    registry.registerRoute("conn-1", {
      route,
      projectLabel: "MyProject",
      sessionLabel: "Fix auth bug",
      hostLabel: "d009-win10",
    });

    // Test /sessions list
    const sessionsResult = await executeSlashCommand({
      text: "/sessions",
      locale: "zh-TW",
      registry,
      dispatcher,
    });
    expect(sessionsResult).toContain("MyProject");
    expect(sessionsResult).toContain("Fix auth bug");
    expect(sessionsResult).toContain("ses_task_999");
    expect(sessionsResult).toContain("/cancel ses_task_999");

    // Test /cancel with valid sessionId
    const cancelResult = await executeSlashCommand({
      text: "/cancel ses_task_999",
      locale: "zh-TW",
      registry,
      dispatcher,
    });
    expect(cancelResult).toContain("任務已成功中止");
    expect(dispatchedCommand).toMatchObject({
      type: "session.cancel",
      route,
    });

    // Test /cancel with missing sessionId
    const usageResult = await executeSlashCommand({
      text: "/cancel",
      locale: "zh-TW",
      registry,
      dispatcher,
    });
    expect(usageResult).toContain("使用方式");

    // Test /cancel with unknown sessionId
    const notFoundResult = await executeSlashCommand({
      text: "/cancel ses_unknown",
      locale: "zh-TW",
      registry,
      dispatcher,
    });
    expect(notFoundResult).toContain("找不到指定 Session");
  });
});
