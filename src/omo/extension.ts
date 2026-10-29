import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { computeNotifierConfigFingerprint, type NotifierConfig } from "../config";
import { resolveLocale, type SupportedLocale } from "../i18n";
import { loadResolvedNotifierConfig } from "../opencode";
import { BrokerClient, derivePluginInstanceId, type RouteIntent } from "../plugin/client";
import type {
  BrokerCommand,
  CommandResult,
  NormalizedNotification,
  NormalizedQuestion,
  RouteKey,
} from "../protocol";
import { deriveProjectId, loadOrCreateStateIdentity } from "../state/identity";
import { PACKAGE_VERSION } from "../version";

const SUMMARY_LIMIT = 600;

type OmoMessage = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
};

export type OmoEntry = { type: string; message?: OmoMessage };

export type OmoSessionManager = {
  getSessionId(): string;
  getSessionName(): string | undefined;
  getHeader(): { spawnedBy?: unknown } | null | undefined;
  getBranch(): OmoEntry[];
  getLeafId(): string | null | undefined;
};

export type OmoContext = {
  cwd: string;
  sessionManager: OmoSessionManager;
  isIdle?: () => boolean;
};

export type UiPromptEvent = { kind?: string; title?: string };

export type AskUserAskedEvent = { ctx?: OmoContext; request?: unknown };

export type OmoExtensionApi = {
  sessionKind?: "interactive" | "worker";
  on(
    event: "agent_settled" | "session_start" | "session_shutdown",
    handler: (event: unknown, ctx: OmoContext) => Promise<void> | void,
  ): void;
  on(
    event: "ui_prompt_start",
    handler: (event: UiPromptEvent, ctx: OmoContext) => Promise<void>,
  ): void;
  events?: {
    on(channel: "ask-user:asked", handler: (data: AskUserAskedEvent) => void): unknown;
    on(channel: "ask-user:closed", handler: (data: { requestId?: unknown }) => void): unknown;
  };
  sendUserMessage?(text: string, options?: { deliverAs?: "steer" | "followUp" }): void;
};

export type OmoSessionInbox = Map<string, (text: string) => void>;

export type SettledOutcome =
  | { kind: "session.completed"; summary?: string }
  | { kind: "session.error"; errorCategory: string };

type PendingQuestion = {
  kind: "question.pending";
  interactionId: string;
  questions: NormalizedQuestion[];
};

type Outcome = SettledOutcome | PendingQuestion;

export type OmoGateway = {
  projectId: string;
  projectLabel: string;
  hostLabel?: string | undefined;
  locale: SupportedLocale;
  notifyCompletion: boolean;
  notifyError: boolean;
  notifyQuestion: boolean;
  broker: {
    readonly connected?: boolean;
    stop?(): Promise<void>;
    activeRoute?(projectId: string, sessionId: string): RouteKey | undefined;
    upsertRoute(intent: RouteIntent): Promise<RouteKey | undefined>;
    publishNotification(notification: NormalizedNotification): Promise<"queued" | "duplicate">;
  };
};

export function resolveSettledOutcome(entries: readonly OmoEntry[]): SettledOutcome | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (entries[index]?.type !== "message" || message?.role !== "assistant") continue;
    if (message.stopReason === "aborted") return undefined;
    if (message.stopReason === "error") {
      return { kind: "session.error", errorCategory: categorizeError(message.errorMessage) };
    }
    const summary = summarize(message.content);
    return { kind: "session.completed", ...(summary ? { summary } : {}) };
  }
  return undefined;
}

function askUserItems(request: unknown): Array<Record<string, unknown>> {
  const questions = (request as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions
    .slice(0, 20)
    .filter(
      (raw): raw is Record<string, unknown> =>
        typeof raw === "object" &&
        raw !== null &&
        Boolean(
          text((raw as Record<string, unknown>).question) ??
            text((raw as Record<string, unknown>).header),
        ),
    );
}

export function normalizeAskUserRequest(request: unknown): PendingQuestion | undefined {
  const requestId = (request as { requestId?: unknown } | null)?.requestId;
  if (typeof requestId !== "string" || !requestId) return undefined;
  const normalized = askUserItems(request).flatMap((item): NormalizedQuestion[] => {
    const question = text(item.question) ?? text(item.header);
    if (!question) return [];
    const options = Array.isArray(item.options) ? item.options : [];
    return [
      {
        question: question.slice(0, 4096),
        header: (text(item.header) ?? question).slice(0, 128),
        options: options.slice(0, 20).flatMap((option) => {
          const label = text((option as { label?: unknown } | null)?.label);
          if (!label) return [];
          const description = text((option as { description?: unknown }).description) ?? "";
          return [{ label: label.slice(0, 256), description: description.slice(0, 2048) }];
        }),
        multiple: item.multiSelect === true,
        custom: true,
      },
    ];
  });
  if (normalized.length === 0) return undefined;
  return {
    kind: "question.pending",
    interactionId: requestId.slice(0, 256),
    questions: normalized,
  };
}

export function uiPromptQuestion(event: UiPromptEvent, interactionId: string): PendingQuestion {
  const kind = text(event.kind) ?? "input";
  return {
    kind: "question.pending",
    interactionId,
    questions: [
      {
        question: (text(event.title) ?? `OMO is waiting for ${kind}`).slice(0, 4096),
        header: kind.slice(0, 128),
        options: [],
        multiple: false,
        custom: true,
      },
    ],
  };
}

export type OmoQuestionTarget = {
  sessionId: string;
  blocking: boolean;
  questions: Array<{ id: string; labels: string[] }>;
};

export type OmoQuestionAnswers = Record<string, { selected: string[]; text?: string }>;

export type OmoCommandTargets = {
  inbox: OmoSessionInbox;
  questions: Map<string, OmoQuestionTarget>;
  answerQuestion: (
    sessionId: string,
    requestId: string,
    answers: OmoQuestionAnswers,
  ) => Promise<void>;
};

export function askUserQuestionTarget(
  request: unknown,
  sessionId: string,
): { requestId: string; target: OmoQuestionTarget } | undefined {
  const requestId = (request as { requestId?: unknown } | null)?.requestId;
  if (typeof requestId !== "string" || !requestId) return undefined;
  const questions = askUserItems(request).map((item) => ({
    id: typeof item.id === "string" ? item.id : "",
    labels: (Array.isArray(item.options) ? item.options : []).flatMap((option) => {
      const label = text((option as { label?: unknown } | null)?.label);
      return label ? [label] : [];
    }),
  }));
  if (questions.length === 0) return undefined;
  const blocking = (request as { waitForAnswer?: unknown }).waitForAnswer !== false;
  return { requestId, target: { sessionId, blocking, questions } };
}

export function buildQuestionAnswers(
  target: OmoQuestionTarget,
  answers: string[][],
): OmoQuestionAnswers | undefined {
  const result: OmoQuestionAnswers = {};
  for (const [index, values] of answers.entries()) {
    const question = target.questions[index];
    if (!question?.id) continue;
    const selected = values.filter((value) => question.labels.includes(value));
    const typed = values.filter((value) => !question.labels.includes(value)).join("\n");
    result[question.id] = { selected, ...(typed ? { text: typed } : {}) };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export async function handleOmoCommand(
  command: BrokerCommand,
  targets: OmoCommandTargets,
): Promise<CommandResult> {
  if (command.type === "question.reply") return await answerOmoQuestion(command, targets);
  if (command.type !== "session.prompt") {
    return {
      commandId: command.commandId,
      status: "rejected",
      reason: "not supported for OMO sessions yet",
    };
  }
  const deliver = targets.inbox.get(command.route.sessionId);
  if (!deliver) {
    return { commandId: command.commandId, status: "rejected", reason: "OMO session is not open" };
  }
  try {
    deliver(command.text);
    return { commandId: command.commandId, status: "accepted" };
  } catch (error) {
    return {
      commandId: command.commandId,
      status: "indeterminate",
      reason: (error instanceof Error ? error.message : "OMO prompt delivery failed").slice(0, 256),
    };
  }
}

async function answerOmoQuestion(
  command: Extract<BrokerCommand, { type: "question.reply" }>,
  targets: OmoCommandTargets,
): Promise<CommandResult> {
  const target = targets.questions.get(command.interactionId);
  if (!target || target.sessionId !== command.route.sessionId) {
    return {
      commandId: command.commandId,
      status: "stale",
      reason: "question is no longer pending",
    };
  }
  if (target.blocking) {
    return {
      commandId: command.commandId,
      status: "rejected",
      reason: "terminal intervention required",
    };
  }
  const answers = buildQuestionAnswers(target, command.answers);
  if (!answers) {
    return { commandId: command.commandId, status: "rejected", reason: "invalid question answer" };
  }
  try {
    await targets.answerQuestion(target.sessionId, command.interactionId, answers);
    targets.questions.delete(command.interactionId);
    return { commandId: command.commandId, status: "accepted" };
  } catch (error) {
    return {
      commandId: command.commandId,
      status: "rejected",
      reason: (error instanceof Error ? error.message : "question answer failed").slice(0, 256),
    };
  }
}

export function createOmoExtension(
  connect: (cwd: string) => Promise<OmoGateway | undefined>,
  onDiagnostic: (message: string) => void = trace,
  inbox: OmoSessionInbox = new Map(),
  questions: Map<string, OmoQuestionTarget> = new Map(),
): (pi: OmoExtensionApi) => void {
  return (pi) => {
    if (pi.sessionKind === "worker") return;
    let uiPromptCount = 0;
    let ownSessionId: string | undefined;
    const deliver = (text: string) => pi.sendUserMessage?.(text, { deliverAs: "followUp" });

    pi.on("session_start", (_event, ctx) => {
      if (ctx.sessionManager.getHeader()?.spawnedBy) return;
      ownSessionId = ctx.sessionManager.getSessionId();
      inbox.set(ownSessionId, deliver);
    });

    pi.on("session_shutdown", () => {
      if (ownSessionId && inbox.get(ownSessionId) === deliver) inbox.delete(ownSessionId);
      ownSessionId = undefined;
    });

    const notify = async (
      ctx: OmoContext,
      resolve: () => { outcome: Outcome; eventId: string } | undefined,
    ): Promise<void> => {
      try {
        const session = ctx.sessionManager;
        if (session.getHeader()?.spawnedBy) return;
        const resolved = resolve();
        if (!resolved) return;
        const { outcome } = resolved;
        const gateway = await connect(ctx.cwd);
        if (!gateway) return;
        if (outcome.kind === "session.completed" && !gateway.notifyCompletion) return;
        if (outcome.kind === "session.error" && !gateway.notifyError) return;
        if (outcome.kind === "question.pending" && !gateway.notifyQuestion) return;

        const sessionId = session.getSessionId();
        const sessionLabel = `OMO: ${session.getSessionName() || sessionId.slice(0, 8)}`.slice(
          0,
          256,
        );
        const route =
          gateway.broker.activeRoute?.(gateway.projectId, sessionId) ??
          (await gateway.broker.upsertRoute({
            projectId: gateway.projectId,
            sessionId,
            projectLabel: gateway.projectLabel,
            sessionLabel,
            active: false,
          }));
        if (!route) {
          onDiagnostic(`route was not registered for OMO session ${sessionId}`);
          return;
        }
        const status = await gateway.broker.publishNotification({
          eventId: resolved.eventId.slice(0, 256),
          route,
          locale: gateway.locale,
          ...(gateway.hostLabel ? { hostLabel: gateway.hostLabel } : {}),
          projectLabel: gateway.projectLabel,
          sessionLabel,
          occurredAt: new Date().toISOString(),
          ...outcome,
        });
        onDiagnostic(`published ${outcome.kind} for OMO session ${sessionId} (${status})`);
      } catch (error) {
        onDiagnostic(
          `OMO notification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    pi.on("agent_settled", (_event, ctx) =>
      notify(ctx, () => {
        const outcome = resolveSettledOutcome(ctx.sessionManager.getBranch());
        if (!outcome) return undefined;
        const leafId = ctx.sessionManager.getLeafId() ?? String(Date.now());
        return { outcome, eventId: `omo:${ctx.sessionManager.getSessionId()}:${leafId}` };
      }),
    );

    pi.events?.on("ask-user:asked", (data) => {
      if (!data.ctx) return;
      const session = data.ctx.sessionManager;
      const answerable = session.getHeader()?.spawnedBy
        ? undefined
        : askUserQuestionTarget(data.request, session.getSessionId());
      if (answerable) questions.set(answerable.requestId, answerable.target);
      void notify(data.ctx, () => {
        const outcome = normalizeAskUserRequest(data.request);
        return outcome && { outcome, eventId: `omo:ask:${outcome.interactionId}` };
      });
    });

    pi.events?.on("ask-user:closed", (data) => {
      if (typeof data.requestId === "string") questions.delete(data.requestId);
    });

    pi.on("ui_prompt_start", (event, ctx) =>
      notify(ctx, () => {
        if (event.kind === "question" || ctx.isIdle?.() !== false) return undefined;
        uiPromptCount += 1;
        const sessionId = ctx.sessionManager.getSessionId();
        const interactionId = `ui:${sessionId}:${Date.now()}:${uiPromptCount}`;
        return { outcome: uiPromptQuestion(event, interactionId), eventId: `omo:${interactionId}` };
      }),
    );
  };
}

type ProcessState = {
  gateways: Map<string, Promise<OmoGateway | undefined>>;
  inbox: OmoSessionInbox;
  questions: Map<string, OmoQuestionTarget>;
  handleCommand: (command: BrokerCommand) => Promise<CommandResult>;
};

const PROCESS_STATE_KEY = Symbol.for("opencode-telegram-link.omo");
const processGlobals = globalThis as Record<symbol, Partial<ProcessState> | undefined>;
const previousState = processGlobals[PROCESS_STATE_KEY];
const processState: ProcessState = {
  gateways: previousState?.gateways ?? new Map(),
  inbox: previousState?.inbox ?? new Map(),
  questions: previousState?.questions ?? new Map(),
  handleCommand: async (command) => {
    const result = await handleOmoCommand(command, {
      inbox: processState.inbox,
      questions: processState.questions,
      answerQuestion: answerThroughControlEndpoint,
    });
    trace(
      `command ${command.type} for ${commandSession(command)}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
    );
    return result;
  },
};
processGlobals[PROCESS_STATE_KEY] = processState;
const { gateways } = processState;

async function connectOnce(cwd: string): Promise<OmoGateway | undefined> {
  const existing = gateways.get(cwd);
  if (existing) {
    const gateway = await existing.catch(() => undefined);
    if (gateway?.broker.connected !== false) return gateway;
    if (gateways.get(cwd) === existing) gateways.delete(cwd);
    void gateway.broker.stop?.();
    return await connectOnce(cwd);
  }
  const pending = connectGateway(cwd).catch((error: unknown) => {
    gateways.delete(cwd);
    throw error;
  });
  gateways.set(cwd, pending);
  return pending;
}

async function connectGateway(cwd: string): Promise<OmoGateway | undefined> {
  const config = await loadResolvedNotifierConfig(undefined, cwd);
  if (!config) {
    trace(`no opencode-telegram-link configuration resolved for ${cwd}`);
    gateways.delete(cwd);
    return undefined;
  }
  const identity = await loadOrCreateStateIdentity();
  const projectLabel = basename(cwd) || "project";
  const broker = new BrokerClient({
    instanceId: derivePluginInstanceId(cwd, identity.machineId),
    host: config.broker.host,
    port: config.broker.port,
    hostLabel: config.hostLabel,
    projectLabel,
    gatewayUrl: config.gateway?.url,
    gatewaySecret: config.gateway?.secret,
    configFingerprint: computeNotifierConfigFingerprint(config),
    packageVersion: PACKAGE_VERSION,
    openCodeVersion: "omo",
    spawnBroker: () => {
      throw new Error("the OMO extension never starts a Gateway");
    },
    onDiagnostic: (code, message) => trace(`BrokerClient ${code}: ${message}`),
    onCommand: (command) => {
      const current =
        processGlobals[PROCESS_STATE_KEY]?.handleCommand ?? processState.handleCommand;
      return current(command);
    },
  });
  await broker.start();
  return {
    projectId: await deriveProjectId(cwd, identity.routeSalt),
    projectLabel,
    hostLabel: config.hostLabel,
    locale: localeFor(config),
    notifyCompletion: config.notifications.completion,
    notifyError: config.notifications.error,
    notifyQuestion: config.notifications.question,
    broker,
  };
}

function localeFor(config: NotifierConfig): SupportedLocale {
  const input: { explicit?: string; system?: string } = {};
  if (config.locale !== "auto") input.explicit = config.locale;
  const system = process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG;
  if (system) input.system = system;
  return resolveLocale(input);
}

function summarize(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        part.type === "text" &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n\n")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  if (!text) return undefined;
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 3)}...` : text;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function categorizeError(message: string | undefined): string {
  if (!message) return "unknown";
  if (/\b(401|403)\b|unauthori[sz]ed|api key|authentication/i.test(message)) return "provider_auth";
  if (/\b429\b|rate limit|quota|usage limit/i.test(message)) return "rate_limit";
  if (/context|too long|maximum.*tokens/i.test(message)) return "context_overflow";
  if (/\b5\d\d\b|overloaded|unavailable|timeout|network/i.test(message)) return "api";
  return "unknown";
}

function trace(message: string): void {
  try {
    appendFileSync(
      join(tmpdir(), "opencode_telegram_omo.log"),
      `[${new Date().toISOString()}] ${message}\n`,
    );
  } catch {}
}

async function answerThroughControlEndpoint(
  sessionId: string,
  requestId: string,
  answers: OmoQuestionAnswers,
): Promise<void> {
  const agentDir =
    process.env.OMO_CODING_AGENT_DIR ??
    process.env.SENPI_CODING_AGENT_DIR ??
    join(homedir(), ".omo", "agent");
  const directory = join(agentDir, "rpc", "tui");
  const sockets = (await readdir(directory).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".sock"))
    .map((name) => join(directory, name));
  for (const socket of sockets) {
    const listed = await controlRequest(socket, { type: "list_sessions" }).catch(() => undefined);
    const sessions = (listed?.data as { sessions?: Array<{ sessionId?: unknown }> } | undefined)
      ?.sessions;
    if (!sessions?.some((session) => session.sessionId === sessionId)) continue;
    const response = await controlRequest(socket, {
      type: "extension_ui_response",
      uiRequestId: requestId,
      answers,
    });
    if (response.success !== true) {
      throw new Error(String(response.error ?? "question answer was refused"));
    }
    return;
  }
  throw new Error("terminal intervention required");
}

async function controlRequest(
  socketPath: string,
  frame: Record<string, unknown>,
): Promise<{ success?: unknown; error?: unknown; data?: unknown }> {
  const secret = await readFile(`${socketPath}.secret`);
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const finish = (
      error?: Error,
      value?: { success?: unknown; error?: unknown; data?: unknown },
    ) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const timeout = setTimeout(() => finish(new Error("OMO control endpoint timed out")), 5_000);
    socket.on("connect", () => {
      socket.write(secret);
      socket.write(`${JSON.stringify({ ...frame, id })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as {
            id?: unknown;
            type?: unknown;
            success?: unknown;
            error?: unknown;
            data?: unknown;
          };
          if (message.id === id && message.type === "response") return finish(undefined, message);
        } catch {}
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("OMO control endpoint closed")));
  });
}

function commandSession(command: BrokerCommand): string {
  return "route" in command ? command.route.sessionId : "new session";
}

// OMO reclaims sockets and timers opened from session callbacks when a session reloads;
// connecting from module scope keeps the Gateway connection (and its route generations)
// owned by the process so Telegram replies to earlier notifications survive /reload.
connectOnce(process.cwd()).catch((error: unknown) =>
  trace(`Gateway connect failed: ${error instanceof Error ? error.message : String(error)}`),
);

export default createOmoExtension(connectOnce, trace, processState.inbox, processState.questions);
