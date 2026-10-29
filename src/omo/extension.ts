import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { computeNotifierConfigFingerprint, type NotifierConfig } from "../config";
import { resolveLocale, type SupportedLocale } from "../i18n";
import { loadResolvedNotifierConfig } from "../opencode";
import { BrokerClient, derivePluginInstanceId, type RouteIntent } from "../plugin/client";
import type { NormalizedNotification, RouteKey } from "../protocol";
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

export type OmoContext = { cwd: string; sessionManager: OmoSessionManager };

export type OmoExtensionApi = {
  sessionKind?: "interactive" | "worker";
  on(event: "agent_settled", handler: (event: unknown, ctx: OmoContext) => Promise<void>): void;
};

export type SettledOutcome =
  | { kind: "session.completed"; summary?: string }
  | { kind: "session.error"; errorCategory: string };

export type OmoGateway = {
  projectId: string;
  projectLabel: string;
  hostLabel?: string | undefined;
  locale: SupportedLocale;
  notifyCompletion: boolean;
  notifyError: boolean;
  broker: {
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

export function createOmoExtension(
  connect: (cwd: string) => Promise<OmoGateway | undefined>,
  onDiagnostic: (message: string) => void = trace,
): (pi: OmoExtensionApi) => void {
  return (pi) => {
    if (pi.sessionKind === "worker") return;
    pi.on("agent_settled", async (_event, ctx) => {
      try {
        const session = ctx.sessionManager;
        if (session.getHeader()?.spawnedBy) return;
        const outcome = resolveSettledOutcome(session.getBranch());
        if (!outcome) return;
        const gateway = await connect(ctx.cwd);
        if (!gateway) return;
        if (outcome.kind === "session.completed" && !gateway.notifyCompletion) return;
        if (outcome.kind === "session.error" && !gateway.notifyError) return;

        const sessionId = session.getSessionId();
        const sessionLabel = `OMO: ${session.getSessionName() || sessionId.slice(0, 8)}`.slice(
          0,
          256,
        );
        const route = await gateway.broker.upsertRoute({
          projectId: gateway.projectId,
          sessionId,
          projectLabel: gateway.projectLabel,
          sessionLabel,
          active: false,
        });
        if (!route) {
          onDiagnostic(`route was not registered for OMO session ${sessionId}`);
          return;
        }
        const leafId = session.getLeafId() ?? String(Date.now());
        const status = await gateway.broker.publishNotification({
          eventId: `omo:${sessionId}:${leafId}`.slice(0, 256),
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
    });
  };
}

const gateways = new Map<string, Promise<OmoGateway | undefined>>();

function connectOnce(cwd: string): Promise<OmoGateway | undefined> {
  const existing = gateways.get(cwd);
  if (existing) return existing;
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
  });
  await broker.start();
  return {
    projectId: await deriveProjectId(cwd, identity.routeSalt),
    projectLabel,
    hostLabel: config.hostLabel,
    locale: localeFor(config),
    notifyCompletion: config.notifications.completion,
    notifyError: config.notifications.error,
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

export default createOmoExtension(connectOnce);
