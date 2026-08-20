import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { computeNotifierConfigFingerprint, readNotifierBotToken } from "./config";
import { resolveLocale } from "./i18n";
import { loadResolvedNotifierConfig, OpenCodeEventBridge } from "./opencode";
import { BrokerClient } from "./plugin/client";
import { runOpenCodeCommand } from "./plugin/commands";
import { deriveProjectId, loadOrCreateStateIdentity } from "./state/identity";

function trace(msg: string) {
  try {
    appendFileSync("/tmp/opencode_telegram_plugin.log", `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

const TelegramLinkPlugin = (async ({ client, directory }, options) => {
  trace(`TelegramLinkPlugin invoked for directory=${directory}`);
  const configData = await loadResolvedNotifierConfig(options, directory);
  if (!configData) {
    trace("TelegramLinkPlugin error: missing or invalid configData");
    await client.app.log({
      body: {
        service: "opencode-telegram-link",
        level: "error",
        message: "Plugin configuration is invalid or missing Telegram credentials",
      },
    });
    return {};
  }

  let botToken: string;
  try {
    botToken = await readNotifierBotToken(configData);
  } catch {
    await client.app.log({
      body: {
        service: "opencode-telegram-link",
        level: "error",
        message: "Telegram bot token could not be loaded",
      },
    });
    return {};
  }
  const localeInput: { explicit?: string; system?: string } = {};
  if (configData.locale !== "auto") localeInput.explicit = configData.locale;
  const systemLocale = process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG;
  if (systemLocale) localeInput.system = systemLocale;
  const locale = resolveLocale(localeInput);

  const broker = new BrokerClient({
    port: configData.broker.port,
    configFingerprint: computeNotifierConfigFingerprint(configData),
    packageVersion: "0.1.0",
    openCodeVersion: "1.18.x",
    telegram: {
      botToken,
      userId: configData.telegram.userId,
      chatId: configData.telegram.chatId,
      locale,
      sessionPromptTtlMinutes: configData.interaction.sessionPromptTtlMinutes,
      questionTtlMinutes: configData.interaction.questionTtlMinutes,
    },
    onCommand: async (command) => runOpenCodeCommand(client, directory, command),
    onDiagnostic: (code, message) => {
      trace(`BrokerClient diagnostic: ${code} - ${message}`);
      void client.app.log({
        body: {
          service: "opencode-telegram-link",
          level: "warn",
          message: `${code}: ${message}`,
        },
      });
    },
  });

  let bridge: OpenCodeEventBridge;
  try {
    trace("Starting BrokerClient...");
    await broker.start();
    trace("BrokerClient started successfully!");
    const identity = await loadOrCreateStateIdentity();
    const projectId = await deriveProjectId(directory, identity.routeSalt);
    bridge = new OpenCodeEventBridge({
      broker,
      projectId,
      projectLabel: basename(directory) || "project",
      locale,
      notificationFilters: {
        completion: configData.notifications.completion,
        error: configData.notifications.error,
        question: configData.notifications.question,
        permission: configData.notifications.permission,
      },
      includeChildLifecycle: configData.notifications.includeChildLifecycle,
      completionDebounceMs: configData.notifications.completionDebounceMs,
      bufferLimit: configData.notifications.pluginBufferSize,
      onNotification: async (notification) => {
        trace(
          `onNotification called for kind=${notification.kind} eventId=${notification.eventId}`,
        );
        const status = await broker.publishNotification(notification);
        trace(`Notification published with status=${status}`);
        await client.app.log({
          body: {
            service: "opencode-telegram-link",
            level: "debug",
            message: `Published OpenCode notification: ${notification.kind} (${status})`,
          },
        });
      },
      onDiagnostic: (code, eventType) => {
        trace(`OpenCodeEventBridge diagnostic: ${code} - ${eventType}`);
        void client.app.log({
          body: {
            service: "opencode-telegram-link",
            level: "warn",
            message: `${code}: ${eventType}`,
          },
        });
      },
    });
  } catch (error) {
    await broker.stop();
    const errMsg = error instanceof Error ? error.stack || error.message : String(error);
    trace(`Broker startup failed: ${errMsg}`);
    await client.app.log({
      body: {
        service: "opencode-telegram-link",
        level: "error",
        message: `Local broker could not be started: ${errMsg}`,
      },
    });
    return {};
  }

  return {
    event: async ({ event }) => {
      trace(`Plugin event hook received: ${JSON.stringify(event)}`);
      await bridge.handle(event);
    },
    dispose: async () => {
      trace("Plugin dispose hook called");
      await bridge.flush();
      bridge.dispose();
      await broker.stop();
    },
  };
}) satisfies Plugin;

export default TelegramLinkPlugin;
