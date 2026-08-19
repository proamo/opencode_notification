import type { PluginInput } from "@opencode-ai/plugin";
import type { BrokerCommand, CommandResult } from "../protocol";

export async function runOpenCodeCommand(
  client: PluginInput["client"],
  directory: string,
  command: BrokerCommand,
): Promise<CommandResult> {
  if (command.type === "session.prompt") {
    return await runSessionPromptCommand(client, directory, command);
  }
  if (command.type === "question.reply") return await runQuestionReplyCommand(client, command);
  const exhaustive: never = command;
  return exhaustive;
}

async function runSessionPromptCommand(
  client: PluginInput["client"],
  directory: string,
  command: Extract<BrokerCommand, { type: "session.prompt" }>,
): Promise<CommandResult> {
  try {
    const response = await client.session.prompt({
      path: { id: command.route.sessionId },
      query: { directory },
      body: { parts: [{ type: "text", text: command.text }] },
    });
    if (response.error) {
      return { commandId: command.commandId, status: "rejected", reason: "session prompt failed" };
    }
    return { commandId: command.commandId, status: "accepted" };
  } catch {
    return {
      commandId: command.commandId,
      status: "indeterminate",
      reason: "session prompt failed",
    };
  }
}

async function runQuestionReplyCommand(
  client: PluginInput["client"],
  command: Extract<BrokerCommand, { type: "question.reply" }>,
): Promise<CommandResult> {
  const reply = questionReplyApi(client);
  if (!reply) {
    return {
      commandId: command.commandId,
      status: "rejected",
      reason: "question reply API unavailable",
    };
  }
  try {
    const response = await reply({
      sessionID: command.route.sessionId,
      requestID: command.interactionId,
      questionV2Reply: { answers: command.answers },
    });
    if (response.error) {
      return { commandId: command.commandId, status: "rejected", reason: "question reply failed" };
    }
    return { commandId: command.commandId, status: "accepted" };
  } catch {
    return {
      commandId: command.commandId,
      status: "indeterminate",
      reason: "question reply failed",
    };
  }
}

type QuestionReplyApi = (parameters: {
  sessionID: string;
  requestID: string;
  questionV2Reply: { answers: string[][] };
}) => Promise<{ error?: unknown }>;

function questionReplyApi(client: PluginInput["client"]): QuestionReplyApi | undefined {
  const maybeClient = client as unknown as {
    session?: { question?: { reply?: QuestionReplyApi } };
  };
  const reply = maybeClient.session?.question?.reply;
  return typeof reply === "function" ? reply.bind(maybeClient.session?.question) : undefined;
}
