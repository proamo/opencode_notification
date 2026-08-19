import { basename } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import {
  computeNotifierConfigFingerprint,
  NotifierConfigSchema,
  readNotifierBotToken,
} from "./config";
import { resolveLocale } from "./i18n";
import { OpenCodeEventBridge } from "./opencode";
import { BrokerClient } from "./plugin/client";
import { runOpenCodeCommand } from "./plugin/commands";
import { deriveProjectId, loadOrCreateStateIdentity } from "./state";

const TelegramLinkPlugin = (async ({ client, directory }, options) => {
  if (!options) return {};

  const config = NotifierConfigSchema.safeParse(options);
  if (!config.success) {
    await client.app.log({
      body: {
        service: "opencode-telegram-link",
        level: "error",
        message: "Plugin configuration is invalid",
      },
    });
    return {};
  }

  let botToken: string;
  try {
    botToken = await readNotifierBotToken(config.data);
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
  if (config.data.locale !== "auto") localeInput.explicit = config.data.locale;
  const systemLocale = process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG;
  if (systemLocale) localeInput.system = systemLocale;
  const locale = resolveLocale(localeInput);

  const broker = new BrokerClient({
    port: config.data.broker.port,
    configFingerprint: computeNotifierConfigFingerprint(config.data),
    packageVersion: "0.1.0",
    openCodeVersion: "1.18.x",
    telegram: {
      botToken,
      userId: config.data.telegram.userId,
      chatId: config.data.telegram.chatId,
      locale,
      sessionPromptTtlMinutes: config.data.interaction.sessionPromptTtlMinutes,
      questionTtlMinutes: config.data.interaction.questionTtlMinutes,
    },
    onCommand: async (command) => runOpenCodeCommand(client, directory, command),
    onDiagnostic: (code, message) => {
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
    await broker.start();
    const identity = await loadOrCreateStateIdentity();
    const projectId = await deriveProjectId(directory, identity.routeSalt);
    bridge = new OpenCodeEventBridge({
      broker,
      projectId,
      projectLabel: basename(directory) || "project",
      locale,
      notificationFilters: {
        completion: config.data.notifications.completion,
        error: config.data.notifications.error,
        question: config.data.notifications.question,
        permission: config.data.notifications.permission,
      },
      includeChildLifecycle: config.data.notifications.includeChildLifecycle,
      completionDebounceMs: config.data.notifications.completionDebounceMs,
      bufferLimit: config.data.notifications.pluginBufferSize,
      onNotification: async (notification) => {
        const status = await broker.publishNotification(notification);
        await client.app.log({
          body: {
            service: "opencode-telegram-link",
            level: "debug",
            message: `Published OpenCode notification: ${notification.kind} (${status})`,
          },
        });
      },
      onDiagnostic: (code, eventType) => {
        void client.app.log({
          body: {
            service: "opencode-telegram-link",
            level: "warn",
            message: `${code}: ${eventType}`,
          },
        });
      },
    });
  } catch {
    await broker.stop();
    await client.app.log({
      body: {
        service: "opencode-telegram-link",
        level: "error",
        message: "Local broker could not be started",
      },
    });
    return {};
  }

  return {
    event: ({ event }) => bridge.handle(event),
    dispose: async () => {
      await bridge.flush();
      bridge.dispose();
      await broker.stop();
    },
  };
}) satisfies Plugin;

export default TelegramLinkPlugin;
