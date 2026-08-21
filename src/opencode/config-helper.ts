import { copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type NotifierConfig, NotifierConfigSchema } from "../config";
import { defaultStateDirectory } from "../state/identity";

export type DiscoveredConfigFile = {
  path: string;
  exists: boolean;
  isWorkspace: boolean;
};

export function getCandidateConfigPaths(cwd: string = process.cwd()): string[] {
  const home = homedir();
  const candidates: string[] = [];

  // Project workspace locations
  candidates.push(join(cwd, "opencode.json"));
  candidates.push(join(cwd, ".opencode", "opencode.json"));
  candidates.push(join(cwd, ".opencode", "config.json"));

  // Global user locations
  if (platform() === "win32") {
    candidates.push(join(home, ".config", "opencode", "opencode.json"));
    candidates.push(join(home, ".config", "opencode", "config.json"));
    if (process.env.APPDATA) {
      candidates.push(join(process.env.APPDATA, "opencode", "opencode.json"));
      candidates.push(join(process.env.APPDATA, "opencode", "config.json"));
    }
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
    candidates.push(join(xdgConfig, "opencode", "opencode.json"));
    candidates.push(join(xdgConfig, "opencode", "config.json"));
    candidates.push(join(home, ".opencode", "opencode.json"));
    candidates.push(join(home, ".opencode", "config.json"));
  }

  return Array.from(new Set(candidates.map((candidate) => resolve(candidate))));
}

export async function discoverOpenCodeConfigFiles(
  cwd: string = process.cwd(),
): Promise<DiscoveredConfigFile[]> {
  const candidates = getCandidateConfigPaths(cwd);
  const results: DiscoveredConfigFile[] = [];

  for (const candidate of candidates) {
    try {
      const stats = await lstat(candidate);
      if (stats.isFile()) {
        results.push({
          path: candidate,
          exists: true,
          isWorkspace: candidate.startsWith(resolve(cwd)),
        });
      }
    } catch {
      // File does not exist
    }
  }

  // If none exists, include the default primary global config path
  if (results.length === 0) {
    const defaultGlobal =
      platform() === "win32"
        ? join(homedir(), ".config", "opencode", "opencode.json")
        : join(
            process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
            "opencode",
            "opencode.json",
          );
    results.push({
      path: resolve(defaultGlobal),
      exists: false,
      isWorkspace: false,
    });
  }

  return results;
}

export function generatePluginConfigSnippet(config: NotifierConfig): string {
  const snippet = {
    plugin: {
      "opencode-telegram-link": {
        mode: config.mode,
        locale: config.locale,
        telegram: {
          tokenFile: config.telegram.tokenFile,
          userId: config.telegram.userId,
          chatId: config.telegram.chatId,
        },
        notifications: {
          completion: config.notifications.completion,
          error: config.notifications.error,
          question: config.notifications.question,
          permission: config.notifications.permission,
        },
      },
    },
  };
  return JSON.stringify(snippet, null, 2);
}

export async function loadResolvedNotifierConfig(
  explicitOptions?: unknown,
  cwd?: string,
): Promise<NotifierConfig | undefined> {
  if (explicitOptions && typeof explicitOptions === "object") {
    const directParse = NotifierConfigSchema.safeParse(explicitOptions);
    if (directParse.success) {
      return directParse.data;
    }
  }

  // Fallback: discover config from workspace and global config files
  const discovered = await discoverOpenCodeConfigFiles(cwd);
  for (const item of discovered) {
    if (!item.exists) continue;
    try {
      const content = await readFile(item.path, "utf8");
      const json = JSON.parse(content) as Record<string, unknown>;
      if (Array.isArray(json.plugin)) {
        for (const entry of json.plugin) {
          if (Array.isArray(entry) && entry.length >= 2) {
            const [key, value] = entry;
            if (
              typeof key === "string" &&
              (key === "opencode-telegram-link" ||
                key.includes("opencode_notification") ||
                key.includes("opencode-telegram"))
            ) {
              const parsed = NotifierConfigSchema.safeParse(value);
              if (parsed.success) {
                return parsed.data;
              }
            }
          }
        }
      }
      const pluginMap =
        json.plugin && typeof json.plugin === "object" && !Array.isArray(json.plugin)
          ? (json.plugin as Record<string, unknown>)
          : undefined;
      if (pluginMap) {
        for (const [key, value] of Object.entries(pluginMap)) {
          if (
            key === "opencode-telegram-link" ||
            key.includes("opencode_notification") ||
            key.includes("opencode-telegram")
          ) {
            const parsed = NotifierConfigSchema.safeParse(value);
            if (parsed.success) {
              return parsed.data;
            }
          }
        }
      }
    } catch {
      // Continue to next candidate
    }
  }

  // Fallback: check stateDirectory for paired credentials
  try {
    const stateDir = defaultStateDirectory();
    const identityPath = join(stateDir, "telegram-identity.json");
    const tokenPath = join(stateDir, "telegram-bot-token");
    let userId: string | undefined;
    let chatId: string | undefined;
    let locale: "auto" | "en" | "zh-TW" = "auto";

    try {
      const identityContent = await readFile(identityPath, "utf8");
      const identityJson = JSON.parse(identityContent) as Record<string, unknown>;
      if (typeof identityJson.userId === "string") userId = identityJson.userId;
      if (typeof identityJson.chatId === "string") chatId = identityJson.chatId;
      if (identityJson.locale === "zh-TW" || identityJson.locale === "en") {
        locale = identityJson.locale;
      }
    } catch {}

    if (!userId || !chatId) {
      if (process.env.OPENCODE_TELEGRAM_USER_ID) userId = process.env.OPENCODE_TELEGRAM_USER_ID;
      if (process.env.OPENCODE_TELEGRAM_CHAT_ID) chatId = process.env.OPENCODE_TELEGRAM_CHAT_ID;
    }

    if (userId && chatId) {
      const parsed = NotifierConfigSchema.safeParse({
        mode: "local",
        locale,
        telegram: {
          tokenFile: tokenPath,
          userId,
          chatId,
        },
      });
      if (parsed.success) {
        return parsed.data;
      }
    }
  } catch {}

  return undefined;
}

export async function injectOpenCodeConfig(
  targetPath: string,
  config: NotifierConfig,
): Promise<{ targetPath: string; backupPath?: string }> {
  let existingJson: Record<string, unknown> = {};
  let backupPath: string | undefined;

  try {
    const existingContent = await readFile(targetPath, "utf8");
    try {
      existingJson = JSON.parse(existingContent) as Record<string, unknown>;
    } catch {
      existingJson = {};
    }
    // Create backup of existing file
    backupPath = `${targetPath}.bak`;
    await copyFile(targetPath, backupPath);
  } catch {
    // File doesn't exist yet, we'll create its parent directory
    await mkdir(dirname(targetPath), { recursive: true });
  }

  // Merge plugin config while preserving existing plugins
  if (Array.isArray(existingJson.plugin)) {
    if (!existingJson.plugin.includes("opencode-telegram-link")) {
      existingJson.plugin.push("opencode-telegram-link");
    }
  } else {
    const existingPlugins = Array.isArray(existingJson.plugins) ? existingJson.plugins : [];
    if (!existingPlugins.includes("opencode-telegram-link")) {
      existingPlugins.push("opencode-telegram-link");
    }
    existingJson.plugins = existingPlugins;

    const existingPluginMap =
      existingJson.plugin && typeof existingJson.plugin === "object"
        ? (existingJson.plugin as Record<string, unknown>)
        : {};

    existingPluginMap["opencode-telegram-link"] = {
      mode: config.mode,
      locale: config.locale,
      telegram: {
        tokenFile: config.telegram.tokenFile,
        userId: config.telegram.userId,
        chatId: config.telegram.chatId,
      },
      notifications: {
        completion: config.notifications.completion,
        error: config.notifications.error,
        question: config.notifications.question,
        permission: config.notifications.permission,
      },
    };
    existingJson.plugin = existingPluginMap;
  }

  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(existingJson, null, 2)}\n`, "utf8");
  await rename(temporaryPath, targetPath);

  return backupPath ? { targetPath, backupPath } : { targetPath };
}

export async function removeOpenCodeConfig(
  targetPath: string,
): Promise<{ modified: boolean; backupPath?: string }> {
  try {
    const existingContent = await readFile(targetPath, "utf8");
    const existingJson = JSON.parse(existingContent) as Record<string, unknown>;

    let modified = false;

    const isPluginMatch = (entry: unknown): boolean => {
      if (typeof entry === "string") {
        return (
          entry === "opencode-telegram-link" ||
          entry.endsWith("opencode_notification") ||
          entry.endsWith("opencode-telegram-link")
        );
      }
      if (Array.isArray(entry) && typeof entry[0] === "string") {
        return isPluginMatch(entry[0]);
      }
      return false;
    };

    // Remove from plugin array
    if (Array.isArray(existingJson.plugin)) {
      const originalLength = existingJson.plugin.length;
      const filtered = existingJson.plugin.filter((p) => !isPluginMatch(p));
      if (filtered.length !== originalLength) {
        existingJson.plugin = filtered;
        modified = true;
      }
    }

    // Remove from legacy plugins array
    if (Array.isArray(existingJson.plugins)) {
      const originalLength = existingJson.plugins.length;
      const filtered = existingJson.plugins.filter((p) => !isPluginMatch(p));
      if (filtered.length !== originalLength) {
        existingJson.plugins = filtered;
        modified = true;
      }
    }

    // Remove from legacy plugin map
    if (
      existingJson.plugin &&
      typeof existingJson.plugin === "object" &&
      !Array.isArray(existingJson.plugin)
    ) {
      const map = existingJson.plugin as Record<string, unknown>;
      for (const key of Object.keys(map)) {
        if (isPluginMatch(key)) {
          delete map[key];
          modified = true;
        }
      }
    }

    if (!modified) {
      return { modified: false };
    }

    // Create backup
    const backupPath = `${targetPath}.bak`;
    await copyFile(targetPath, backupPath);

    const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(existingJson, null, 2)}\n`, "utf8");
    await rename(temporaryPath, targetPath);

    return { modified: true, backupPath };
  } catch {
    return { modified: false };
  }
}
