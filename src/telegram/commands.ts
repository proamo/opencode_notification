import { randomUUID } from "node:crypto";
import type { RouteRegistry } from "../broker/registry";
import { type SupportedLocale, translate } from "../i18n";
import type { BrokerCommand, CommandResult } from "../protocol";

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
    case "run": {
      return await handleRunCommand(args, context, locale);
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
    `• <code>/run &lt;project&gt; &lt;prompt&gt;</code> - ${translate(locale, "cmd.help.run")}`,
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
    `🏢 <b>Gateway Version:</b> <code>v${context.packageVersion ?? "1.0.0-rc.1"}</code>`,
    `⏱️ <b>Uptime:</b> <code>${uptimeString}</code>`,
    `💾 <b>Memory RSS:</b> <code>${rssMb} MB</code>`,
    `🌐 <b>Connected Nodes:</b> <code>${nodes.length}</code>`,
    `🛣️ <b>Active Routes:</b> <code>${totalRoutes}</code>`,
  ];
  return lines.join("\n");
}

function renderConnectedNodes(context: SlashCommandContext, locale: SupportedLocale): string {
  const machines = context.registry.listMachines();
  if (machines.length === 0) {
    return `${translate(locale, "cmd.nodes.title")}\n\n${translate(locale, "cmd.nodes.empty")}`;
  }

  const lines = [translate(locale, "cmd.nodes.title"), ""];

  for (const m of machines) {
    const isLocal = m.hostLabel === "local" ? "codeCenter" : m.hostLabel;
    const projectCountText =
      locale === "zh-TW"
        ? `${m.connectionsCount} 個專案連線`
        : `${m.connectionsCount} project connection(s)`;

    lines.push(`🖥️ <b>[${isLocal}]</b> 🟢 Online (${projectCountText})`);
    lines.push(`  • Machine ID: <code>${m.machineId.slice(0, 8)}...</code>`);

    if (m.projects.length > 0) {
      lines.push("  • <b>活躍專案與 Session：</b>");
      for (const p of m.projects) {
        lines.push(`    📁 <code>${p.projectLabel}</code> - <i>${p.sessionLabel}</i>`);
      }
    } else {
      const idleText = locale === "zh-TW" ? "待命中（無進行中任務）" : "Idle (no active tasks)";
      lines.push(`  • 狀態：<i>${idleText}</i>`);
    }
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

  const lookup = context.registry.lookupSession(sessionId);
  if (lookup.status === "ambiguous") {
    return translate(locale, "cmd.cancel.ambiguous");
  }
  if (lookup.status === "not_found") {
    return translate(locale, "cmd.cancel.notFound");
  }

  const commandId = randomUUID();
  const result = await context.dispatcher.sendCommand({
    type: "session.cancel",
    commandId,
    route: lookup.route,
    reason: "canceled via Telegram /cancel command",
  });

  if (result.status === "accepted") {
    return translate(locale, "cmd.cancel.success");
  }

  return `${translate(locale, "cmd.cancel.failed")} (${result.reason ?? result.status})`;
}

async function handleRunCommand(
  args: string[],
  context: SlashCommandContext,
  locale: SupportedLocale,
): Promise<string> {
  if (args.length === 0) {
    return translate(locale, "cmd.run.usage");
  }

  // 1. Check if targetArg is an existing Session ID / prefix (e.g. /run ses_4a8b... fix login bug)
  const targetArg = args[0] ?? "";
  let prompt = args.slice(1).join(" ").trim();

  const isSessionCandidate =
    targetArg.startsWith("ses_") ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(targetArg) ||
    (targetArg.length >= 6 && prompt.length > 0);

  if (isSessionCandidate && prompt) {
    const lookup = context.registry.lookupSession(targetArg);
    if (lookup.status === "ambiguous") {
      return translate(locale, "cmd.run.ambiguous");
    }
    if (lookup.status === "found") {
      const commandId = randomUUID();
      const result = await context.dispatcher.sendCommand({
        type: "session.prompt",
        commandId,
        route: lookup.route,
        text: prompt,
      });

      if (result.status === "accepted") {
        const hostTag = lookup.hostLabel ? `[${lookup.hostLabel}] ` : "";
        const promptDisplay = prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
        const lines = [
          locale === "zh-TW"
            ? `🔄 <b>已成功接續至歷史工作階段：${hostTag}${lookup.projectLabel ?? "專案"}</b>`
            : `🔄 <b>Resumed session: ${hostTag}${lookup.projectLabel ?? "project"}</b>`,
          "",
          `📝 <b>Session:</b> <i>${lookup.sessionLabel ?? "任務"}</i> (<code>${lookup.route.sessionId}</code>)`,
          `💬 <b>指令：</b> <i>${promptDisplay}</i>`,
          "",
          locale === "zh-TW"
            ? "⏳ 正在該 Session 上下文中執行，完成後將自動推播結論！"
            : "⏳ Running in existing session context, a notification will arrive upon completion.",
        ];
        return lines.join("\n");
      }

      return `${translate(locale, "cmd.run.failed")}: ${result.reason ?? result.status}`;
    }
  }

  // 2. Try matching targetArg as project or host name (spawn new session)
  let targetConn = context.registry.findConnection(targetArg);

  // 3. If not found with 1st arg, maybe target was 2 words (e.g. /run d009-win10 openclaw check logs)
  if (!targetConn && args.length >= 3) {
    const conn2 =
      context.registry.findConnection(args[1]) ?? context.registry.findConnection(args[0]);
    if (conn2) {
      targetConn = conn2;
      prompt = args.slice(2).join(" ").trim();
    }
  }

  // 4. If still not found and only 1 connection is online, treat entire args as prompt
  if (!targetConn) {
    const defaultConn = context.registry.findConnection(undefined);
    if (defaultConn) {
      targetConn = defaultConn;
      prompt = args.join(" ").trim();
    }
  }

  if (!targetConn || !prompt) {
    return `${translate(locale, "cmd.run.notFound")}\n\n${translate(locale, "cmd.run.usage")}`;
  }

  const commandId = randomUUID();
  const hostName = targetConn.hostLabel || "codeCenter";
  const projectName = targetConn.projectLabel || "project";

  const result = await context.dispatcher.sendCommand({
    type: "session.spawn",
    commandId,
    instanceId: targetConn.instanceId,
    title: prompt.slice(0, 50),
    prompt,
  });

  if (result.status === "accepted") {
    const sessionId = result.reason ? `<code>${result.reason}</code>` : "";
    const promptDisplay = prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
    const lines = [
      `${translate(locale, "cmd.run.spawned")} <b>[${hostName}] ${projectName}</b> 🚀`,
      "",
      `📝 <b>指令：</b> <i>${promptDisplay}</i>`,
      ...(sessionId ? [`🆔 <b>Session:</b> ${sessionId}`] : []),
      "",
      locale === "zh-TW"
        ? "⏳ 任務已啟動，執行完成後將自動推播結論至此！"
        : "⏳ Task started! A notification with the summary will arrive upon completion.",
    ];
    return lines.join("\n");
  }

  return `${translate(locale, "cmd.run.failed")}: ${result.reason ?? result.status}`;
}
