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
  if (command.type === "question.reply") {
    return await runQuestionReplyCommand(client, command);
  }
  if (command.type === "permission.reply") {
    return await runPermissionReplyCommand(client, directory, command);
  }
  if (command.type === "session.cancel") {
    return await runSessionCancelCommand(client, directory, command);
  }
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

async function runPermissionReplyCommand(
  client: PluginInput["client"],
  directory: string,
  command: Extract<BrokerCommand, { type: "permission.reply" }>,
): Promise<CommandResult> {
  const reply = permissionReplyApi(client);
  if (!reply) {
    return {
      commandId: command.commandId,
      status: "rejected",
      reason: "permission reply API unavailable",
    };
  }
  try {
    const response = await reply({
      path: { id: command.route.sessionId, permissionID: command.interactionId },
      query: { directory },
      body: { response: command.response },
    });
    if (response && typeof response === "object" && "error" in response && response.error) {
      return {
        commandId: command.commandId,
        status: "rejected",
        reason: "permission reply failed",
      };
    }
    return { commandId: command.commandId, status: "accepted" };
  } catch {
    return {
      commandId: command.commandId,
      status: "indeterminate",
      reason: "permission reply failed",
    };
  }
}

type PermissionReplyApi = (parameters: {
  path: { id: string; permissionID: string };
  query?: { directory?: string };
  body: { response: "once" | "always" | "reject" };
}) => Promise<{ error?: unknown; data?: unknown }>;

function permissionReplyApi(client: PluginInput["client"]): PermissionReplyApi | undefined {
  const maybeClient = client as unknown as {
    postSessionIdPermissionsPermissionId?: PermissionReplyApi;
    session?: {
      permission?: {
        reply?: (opts: {
          sessionID: string;
          permissionID: string;
          response: string;
        }) => Promise<{ error?: unknown }>;
      };
    };
  };
  if (typeof maybeClient.postSessionIdPermissionsPermissionId === "function") {
    return maybeClient.postSessionIdPermissionsPermissionId.bind(client);
  }
  if (typeof maybeClient.session?.permission?.reply === "function") {
    const fn = maybeClient.session.permission.reply.bind(maybeClient.session.permission);
    return async (params) => {
      return await fn({
        sessionID: params.path.id,
        permissionID: params.path.permissionID,
        response: params.body.response,
      });
    };
  }
  return undefined;
}

async function runSessionCancelCommand(
  client: PluginInput["client"],
  directory: string,
  command: Extract<BrokerCommand, { type: "session.cancel" }>,
): Promise<CommandResult> {
  const maybeSession = client.session as unknown as {
    abort?: (params: { path: { id: string }; query?: { directory?: string } }) => Promise<{ error?: unknown }>;
    stop?: (params: { path: { id: string } }) => Promise<{ error?: unknown }>;
    cancel?: (params: { path: { id: string } }) => Promise<{ error?: unknown }>;
  };

  try {
    if (typeof maybeSession?.abort === "function") {
      const res = await maybeSession.abort({ path: { id: command.route.sessionId }, query: { directory } });
      if (res && typeof res === "object" && "error" in res && res.error) {
        return { commandId: command.commandId, status: "rejected", reason: "session abort failed" };
      }
      return { commandId: command.commandId, status: "accepted" };
    }
    if (typeof maybeSession?.stop === "function") {
      const res = await maybeSession.stop({ path: { id: command.route.sessionId } });
      if (res && typeof res === "object" && "error" in res && res.error) {
        return { commandId: command.commandId, status: "rejected", reason: "session stop failed" };
      }
      return { commandId: command.commandId, status: "accepted" };
    }
    if (typeof maybeSession?.cancel === "function") {
      const res = await maybeSession.cancel({ path: { id: command.route.sessionId } });
      if (res && typeof res === "object" && "error" in res && res.error) {
        return { commandId: command.commandId, status: "rejected", reason: "session cancel failed" };
      }
      return { commandId: command.commandId, status: "accepted" };
    }

    return { commandId: command.commandId, status: "rejected", reason: "cancel API not supported by OpenCode client" };
  } catch {
    return { commandId: command.commandId, status: "indeterminate", reason: "cancel execution error" };
  }
}
