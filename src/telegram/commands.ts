import { randomUUID } from "node:crypto";
import { type SupportedLocale, translate } from "../i18n";
import type { BrokerCommand, CommandResult, RouteKey } from "../protocol";
import type { RouteRegistry } from "../broker/registry";

export type SlashCommandContext = {
  text: string;
  locale?: SupportedLocale;
  registry: RouteRegistry;
  dispatcher: {
    sendCommand(command: BrokerCommand): Promise<CommandResult>;
  };
  startedAt?: number;
  packageVersion?: string;
};

export function isSlashCommand(text?: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed.startsWith("/") && trimmed.length > 1;
}

export function parseSlashCommand(text: string): { command: string; args: string[] } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;

  const rawCommand = parts[0];
  if (!rawCommand) return undefined;

  // Handle command@bot_username format
  const command = rawCommand.split("@")[0]?.toLowerCase() ?? "";
  const args = parts.slice(1);

  return { command, args };
}

export async function executeSlashCommand(context: SlashCommandContext): Promise<string> {
  const parsed = parseSlashCommand(context.text);
  const locale: SupportedLocale = context.locale ?? "zh-TW";

  if (!parsed) {
    return translate(locale, "cmd.unknown");
  }

  const { command, args } = parsed;

  switch (command) {
    case "start":
    case "help": {
      return renderHelpMenu(locale);
    }
    case "status": {
      return renderGatewayStatus(context, locale);
    }
    case "nodes": {
      return renderConnectedNodes(context, locale);
    }
    case "sessions": {
      return renderActiveSessions(context, locale);
    }
    case "cancel": {
      return await handleCancelCommand(args, context, locale);
    }
    default: {
      return translate(locale, "cmd.unknown");
    }
  }
}

function renderHelpMenu(locale: SupportedLocale): string {
  const lines = [
    translate(locale, "cmd.help.title"),
    "",
    `• <code>/status</code> - ${translate(locale, "cmd.help.status")}`,
    `• <code>/nodes</code> - ${translate(locale, "cmd.help.nodes")}`,
    `• <code>/sessions</code> - ${translate(locale, "cmd.help.sessions")}`,
    `• <code>/cancel &lt;session_id&gt;</code> - ${translate(locale, "cmd.help.cancel")}`,
    `• <code>/help</code> - ${translate(locale, "cmd.help.help")}`,
  ];
  return lines.join("\n");
}

function renderGatewayStatus(context: SlashCommandContext, locale: SupportedLocale): string {
  const uptimeMs = Date.now() - (context.startedAt ?? Date.now());
  const uptimeMinutes = Math.floor(uptimeMs / 60000);
  const uptimeHours = Math.floor(uptimeMinutes / 60);
  const uptimeString =
    uptimeHours > 0 ? `${uptimeHours}h ${uptimeMinutes % 60}m` : `${uptimeMinutes}m`;

  const memUsage = process.memoryUsage();
  const rssMb = Math.round((memUsage.rss / 1024 / 1024) * 10) / 10;

  const nodes = context.registry.listNodes();
  const totalRoutes = context.registry.routeCount;

  const lines = [
    translate(locale, "cmd.status.title"),
    "",
    `🏢 <b>Gateway Version:</b> <code>v${context.packageVersion ?? "3.0.0"}</code>`,
    `⏱️ <b>Uptime:</b> <code>${uptimeString}</code>`,
    `💾 <b>Memory RSS:</b> <code>${rssMb} MB</code>`,
    `🌐 <b>Connected Nodes:</b> <code>${nodes.length}</code>`,
    `🛣️ <b>Active Routes:</b> <code>${totalRoutes}</code>`,
  ];
  return lines.join("\n");
}

function renderConnectedNodes(context: SlashCommandContext, locale: SupportedLocale): string {
  const nodes = context.registry.listNodes();
  if (nodes.length === 0) {
    return `${translate(locale, "cmd.nodes.title")}\n\n${translate(locale, "cmd.nodes.empty")}`;
  }

  const lines = [translate(locale, "cmd.nodes.title"), ""];

  for (const node of nodes) {
    const label = node.hostLabel || "local";
    lines.push(`🖥️ <b>[${label}]</b> 🟢 Online`);
    lines.push(`  • Machine ID: <code>${node.machineId.slice(0, 8)}...</code>`);
    lines.push(`  • Active Routes: <code>${node.activeRoutesCount}</code>`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function renderActiveSessions(context: SlashCommandContext, locale: SupportedLocale): string {
  const sessions = context.registry.listActiveSessions();
  if (sessions.length === 0) {
    return `${translate(locale, "cmd.sessions.title")}\n\n${translate(locale, "cmd.sessions.empty")}`;
  }

  const lines = [translate(locale, "cmd.sessions.title"), ""];

  for (const session of sessions) {
    const hostTag = session.hostLabel ? `[${session.hostLabel}] ` : "";
    lines.push(`📌 <b>${hostTag}${session.projectLabel}</b>`);
    lines.push(`  • Session: <b>${session.sessionLabel}</b>`);
    lines.push(`  • ID: <code>${session.route.sessionId}</code>`);
    lines.push(`  • Cancel: <code>/cancel ${session.route.sessionId}</code>`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

async function handleCancelCommand(
  args: string[],
  context: SlashCommandContext,
  locale: SupportedLocale,
): Promise<string> {
  const sessionId = args[0]?.trim();
  if (!sessionId) {
    return translate(locale, "cmd.cancel.usage");
  }

  // Find the route for this session ID
  const activeSessions = context.registry.listActiveSessions();
  const target = activeSessions.find(
    (s) => s.route.sessionId === sessionId || s.route.sessionId.startsWith(sessionId),
  );

  let targetRoute: RouteKey | undefined = target?.route;

  if (!targetRoute) {
    // Attempt to match by exact sessionId in registry.resolve
    const dummyRoute: RouteKey = {
      machineId: "00000000-0000-0000-0000-000000000000",
      instanceId: "00000000-0000-0000-0000-000000000000",
      projectId: "unknown",
      sessionId,
      routeGeneration: "00000000-0000-0000-0000-000000000000",
    };
    const resolved = context.registry.resolve(dummyRoute);
    if (resolved) {
      targetRoute = resolved.route;
    }
  }

  if (!targetRoute) {
    return translate(locale, "cmd.cancel.notFound");
  }

  const commandId = randomUUID();
  const result = await context.dispatcher.sendCommand({
    type: "session.cancel",
    commandId,
    route: targetRoute,
    reason: "canceled via Telegram /cancel command",
  });

  if (result.status === "accepted") {
    return translate(locale, "cmd.cancel.success");
  }

  return `${translate(locale, "cmd.cancel.failed")} (${result.reason ?? result.status})`;
}
