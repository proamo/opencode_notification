import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { type BrokerConnectionData, RouteRegistry } from "../src/broker/registry";
import type { BrokerCommand, CommandResult, RouteKey } from "../src/protocol";
import { executeSlashCommand, isSlashCommand, parseSlashCommand } from "../src/telegram/commands";

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
    const dispatcher = {
      sendCommand: async () => ({ commandId: "123", status: "accepted" as const }),
    };

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
    const dispatcher = {
      sendCommand: async () => ({ commandId: "123", status: "accepted" as const }),
    };

    const result = await executeSlashCommand({
      text: "/status",
      locale: "zh-TW",
      registry,
      dispatcher,
      startedAt: Date.now() - 120_000,
      packageVersion: "1.0.0-rc.1",
    });

    expect(result).toContain("Gateway 系統狀態");
    expect(result).toContain("v1.0.0-rc.1");
    expect(result).toContain("2m");
    expect(result).toContain("Memory RSS");
  });

  test("renders connected nodes list", async () => {
    const registry = new RouteRegistry();
    const dispatcher = {
      sendCommand: async () => ({ commandId: "123", status: "accepted" as const }),
    };

    // When empty
    const emptyResult = await executeSlashCommand({
      text: "/nodes",
      locale: "zh-TW",
      registry,
      dispatcher,
    });
    expect(emptyResult).toContain("目前沒有任何在線電腦");

    // Register a mock node
    const fakeSocket = {
      data: { connectionId: "conn-1" },
      close: () => {},
    } as unknown as ServerWebSocket<BrokerConnectionData>;
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
    const fakeSocket = {
      data: { connectionId: "conn-1" },
      close: () => {},
    } as unknown as ServerWebSocket<BrokerConnectionData>;
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

  test("dispatches /run command to target machine and project", async () => {
    const registry = new RouteRegistry();
    let dispatchedCommand: BrokerCommand | undefined;
    const dispatcher = {
      sendCommand: async (cmd: BrokerCommand): Promise<CommandResult> => {
        dispatchedCommand = cmd;
        return {
          commandId: cmd.commandId,
          status: "accepted",
          reason: "ses_new_12345678",
        };
      },
    };

    const machineId = crypto.randomUUID();
    const instanceId = crypto.randomUUID();
    const fakeSocket = {
      data: { connectionId: "conn-1" },
      close: () => {},
    } as unknown as ServerWebSocket<BrokerConnectionData>;
    registry.registerConnection(fakeSocket, instanceId, machineId, "d009-win10", "openclaw");

    // Test /run openclaw
    const runResult = await executeSlashCommand({
      text: "/run openclaw run integration tests",
      locale: "zh-TW",
      registry,
      dispatcher,
    });
    expect(runResult).toContain("任務已成功指派至");
    expect(runResult).toContain("[d009-win10] openclaw");
    expect(runResult).toContain("ses_new_12345678");
    expect(dispatchedCommand).toMatchObject({
      type: "session.spawn",
      instanceId,
      prompt: "run integration tests",
    });

    // Test /run usage
    const usageResult = await executeSlashCommand({
      text: "/run",
      locale: "zh-TW",
      registry,
      dispatcher,
    });
    expect(usageResult).toContain("使用方式");

    // Test /run with existing Session ID to resume
    const route: RouteKey = {
      machineId,
      instanceId,
      projectId: "opaque-project-alpha-12345",
      sessionId: "ses_history_abc",
      routeGeneration: crypto.randomUUID(),
    };
    registry.registerRoute("conn-1", {
      route,
      projectLabel: "MyProject",
      sessionLabel: "Delivered 3 days ago",
      hostLabel: "d009-win10",
    });

    const resumeResult = await executeSlashCommand({
      text: "/run ses_history_abc fix reported bug",
      locale: "zh-TW",
      registry,
      dispatcher,
    });
    expect(resumeResult).toContain("已成功接續至歷史工作階段");
    expect(resumeResult).toContain("MyProject");
    expect(resumeResult).toContain("ses_history_abc");
    expect(dispatchedCommand).toMatchObject({
      type: "session.prompt",
      route,
      text: "fix reported bug",
    });
  });

  test("handleCancelCommand fails closed when duplicate sessionId exists across instances without dispatching", async () => {
    const registry = new RouteRegistry();
    let commandDispatched = false;
    const dispatcher = {
      sendCommand: async (cmd: BrokerCommand): Promise<CommandResult> => {
        commandDispatched = true;
        return { commandId: cmd.commandId, status: "accepted" };
      },
    };

    const machineId = crypto.randomUUID();
    const instA = crypto.randomUUID();
    const instB = crypto.randomUUID();
    const sharedSessionId = "ses_duplicate_111222";

    const socketA = {
      data: { connectionId: "conn-a" },
      close: () => {},
    } as unknown as ServerWebSocket<BrokerConnectionData>;
    const socketB = {
      data: { connectionId: "conn-b" },
      close: () => {},
    } as unknown as ServerWebSocket<BrokerConnectionData>;

    registry.registerConnection(socketA, instA, machineId, "HostA", "ProjectA");
    registry.registerConnection(socketB, instB, machineId, "HostB", "ProjectB");

    registry.registerRoute("conn-a", {
      route: {
        machineId,
        instanceId: instA,
        projectId: "project-a-12345678",
        sessionId: sharedSessionId,
        routeGeneration: crypto.randomUUID(),
      },
      projectLabel: "ProjectA",
      sessionLabel: "Task A",
    });

    registry.registerRoute("conn-b", {
      route: {
        machineId,
        instanceId: instB,
        projectId: "project-b-12345678",
        sessionId: sharedSessionId,
        routeGeneration: crypto.randomUUID(),
      },
      projectLabel: "ProjectB",
      sessionLabel: "Task B",
    });

    const cancelResult = await executeSlashCommand({
      text: `/cancel ${sharedSessionId}`,
      locale: "zh-TW",
      registry,
      dispatcher,
    });

    // Must fail closed with ambiguous error and NEVER dispatch to the first instance!
    expect(cancelResult).toContain("目標 Session 不明確");
    expect(commandDispatched).toBe(false);
  });

  test("handleRunCommand fails closed when prefix matches multiple different sessions without dispatching", async () => {
    const registry = new RouteRegistry();
    let commandDispatched = false;
    const dispatcher = {
      sendCommand: async (cmd: BrokerCommand): Promise<CommandResult> => {
        commandDispatched = true;
        return { commandId: cmd.commandId, status: "accepted" };
      },
    };

    const machineId = crypto.randomUUID();
    const instA = crypto.randomUUID();
    const socketA = {
      data: { connectionId: "conn-a" },
      close: () => {},
    } as unknown as ServerWebSocket<BrokerConnectionData>;

    registry.registerConnection(socketA, instA, machineId, "HostA", "ProjectA");

    // Register two sessions with the same prefix "ses_prefix_"
    registry.registerRoute("conn-a", {
      route: {
        machineId,
        instanceId: instA,
        projectId: "project-a-12345678",
        sessionId: "ses_prefix_alpha_111",
        routeGeneration: crypto.randomUUID(),
      },
      projectLabel: "ProjectA",
      sessionLabel: "Task 1",
    });

    registry.registerRoute("conn-a", {
      route: {
        machineId,
        instanceId: instA,
        projectId: "project-a-12345678",
        sessionId: "ses_prefix_beta_222",
        routeGeneration: crypto.randomUUID(),
      },
      projectLabel: "ProjectA",
      sessionLabel: "Task 2",
    });

    const runResult = await executeSlashCommand({
      text: "/run ses_prefix_ continue testing",
      locale: "zh-TW",
      registry,
      dispatcher,
    });

    // Must fail closed with ambiguous error and NEVER dispatch to the first match!
    expect(runResult).toContain("目標 Session 不明確");
    expect(commandDispatched).toBe(false);
  });
});
