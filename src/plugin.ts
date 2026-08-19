import { basename } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { NotifierConfigSchema } from "./config";
import { resolveLocale } from "./i18n";
import { OpenCodeEventBridge } from "./opencode";
import { BrokerClient } from "./plugin/client";
import { deriveProjectId, loadOrCreateStateIdentity } from "./state";

export const TelegramLinkPlugin = (async ({ client, directory }, options) => {
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

  const broker = new BrokerClient({
    port: config.data.broker.port,
    packageVersion: "0.0.0",
    openCodeVersion: "1.18.x",
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
    const localeInput: { explicit?: string; system?: string } = {};
    if (config.data.locale !== "auto") localeInput.explicit = config.data.locale;
    const systemLocale = process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG;
    if (systemLocale) localeInput.system = systemLocale;
    const locale = resolveLocale(localeInput);
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
        await client.app.log({
          body: {
            service: "opencode-telegram-link",
            level: "debug",
            message: `Normalized OpenCode event: ${notification.kind}`,
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
      bridge.dispose();
      await broker.stop();
    },
  };
}) satisfies Plugin;

export default TelegramLinkPlugin;
