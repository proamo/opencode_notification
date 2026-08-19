import { describe, expect, test } from "bun:test";
import type { PluginInput } from "@opencode-ai/plugin";
import { runOpenCodeCommand } from "../src/plugin/commands";
import type { BrokerCommand } from "../src/protocol";

describe("runOpenCodeCommand", () => {
  test("calls the exact OpenCode question reply API when available", async () => {
    const calls: unknown[] = [];
    const client = {
      session: {
        question: {
          reply: async (parameters: unknown) => {
            calls.push(parameters);
            return {};
          },
        },
      },
    } as unknown as PluginInput["client"];
    const command = questionCommand();

    const result = await runOpenCodeCommand(client, "/repo", command);

    expect(result).toEqual({ commandId: command.commandId, status: "accepted" });
    expect(calls).toEqual([
      {
        sessionID: command.route.sessionId,
        requestID: command.interactionId,
        questionV2Reply: { answers: [["Option A"]] },
      },
    ]);
  });

  test("rejects question replies when the OpenCode client does not expose the API", async () => {
    const client = { session: {} } as unknown as PluginInput["client"];
    const command = questionCommand();

    await expect(runOpenCodeCommand(client, "/repo", command)).resolves.toMatchObject({
      commandId: command.commandId,
      status: "rejected",
      reason: "question reply API unavailable",
    });
  });
});

function questionCommand(): Extract<BrokerCommand, { type: "question.reply" }> {
  return {
    type: "question.reply",
    commandId: crypto.randomUUID(),
    route: {
      machineId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      projectId: "opaque-project-id",
      sessionId: "ses_123",
      routeGeneration: crypto.randomUUID(),
    },
    interactionId: "question_1",
    answers: [["Option A"]],
  };
}
