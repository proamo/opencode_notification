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

export function parseJsonc<T = Record<string, unknown>>(content: string): T {
  let insideString = false;
  let stringChar = "";
  let isEscaped = false;
  let result = "";

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (insideString) {
      result += char;
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === stringChar) {
        insideString = false;
      }
    } else {
      if (char === '"' || char === "'") {
        insideString = true;
        stringChar = char;
        result += char;
      } else if (char === "/" && nextChar === "/") {
        // Single-line comment: skip until newline
        while (i < content.length && content[i] !== "\n" && content[i] !== "\r") {
          i++;
        }
        if (i < content.length) {
          result += content[i];
        }
      } else if (char === "/" && nextChar === "*") {
        // Multi-line block comment: skip until */
        i += 2;
        while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
          if (content[i] === "\n") result += "\n";
          i++;
        }
        i++; // skip /
      } else {
        result += char;
      }
    }
  }

  // Strip trailing commas before } or ]
  const cleaned = result.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(cleaned) as T;
}

export function getCandidateConfigPaths(cwd: string = process.cwd()): string[] {
  const home = homedir();
  const candidates: string[] = [];

  // Project workspace locations
  candidates.push(join(cwd, "opencode.json"));
  candidates.push(join(cwd, "opencode.jsonc"));
  candidates.push(join(cwd, ".opencode", "opencode.json"));
  candidates.push(join(cwd, ".opencode", "opencode.jsonc"));
  candidates.push(join(cwd, ".opencode", "config.json"));

  // Global user locations
  if (platform() === "win32") {
    candidates.push(join(home, ".config", "opencode", "opencode.json"));
    candidates.push(join(home, ".config", "opencode", "opencode.jsonc"));
    candidates.push(join(home, ".config", "opencode", "config.json"));
    if (process.env.APPDATA) {
      candidates.push(join(process.env.APPDATA, "opencode", "opencode.json"));
      candidates.push(join(process.env.APPDATA, "opencode", "opencode.jsonc"));
      candidates.push(join(process.env.APPDATA, "opencode", "config.json"));
    }
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
    candidates.push(join(xdgConfig, "opencode", "opencode.json"));
    candidates.push(join(xdgConfig, "opencode", "opencode.jsonc"));
    candidates.push(join(xdgConfig, "opencode", "config.json"));
    candidates.push(join(home, ".opencode", "opencode.json"));
    candidates.push(join(home, ".opencode", "opencode.jsonc"));
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
  const pluginConfig: Record<string, unknown> = {
    mode: config.mode,
    role: config.role,
    ...(config.hostLabel ? { hostLabel: config.hostLabel } : {}),
    locale: config.locale,
    notifications: {
      completion: config.notifications.completion,
      error: config.notifications.error,
      question: config.notifications.question,
      permission: config.notifications.permission,
    },
  };
  if (config.role === "node" && config.gateway) {
    pluginConfig.gateway = {
      url: config.gateway.url,
      secret: config.gateway.secret,
    };
  } else if (config.telegram) {
    pluginConfig.telegram = {
      tokenFile: config.telegram.tokenFile,
      userId: config.telegram.userId,
      chatId: config.telegram.chatId,
    };
  }
  const snippet = {
    plugin: {
      "opencode-telegram-link": pluginConfig,
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
      const json = parseJsonc(content) as Record<string, unknown>;
      if (Array.isArray(json.plugin)) {
        for (const entry of json.plugin) {
          if (Array.isArray(entry) && entry.length >= 2) {
            const [key, value] = entry;
            if (
              typeof key === "string" &&
              (key === "opencode-telegram-link" ||
                key.includes("opencode_notification") ||
                key.includes("telegram") ||
                key.includes("plugin"))
            ) {
              const parsed = NotifierConfigSchema.safeParse(value);
              if (parsed.success) return parsed.data;
            }
          }
        }
      }
      if (json.plugin && typeof json.plugin === "object") {
        for (const [key, value] of Object.entries(json.plugin)) {
          if (
            key === "opencode-telegram-link" ||
            key.includes("opencode_notification") ||
            key.includes("telegram") ||
            key.includes("plugin")
          ) {
            const parsed = NotifierConfigSchema.safeParse(value);
            if (parsed.success) return parsed.data;
          }
        }
      }
      if (json["opencode-telegram-link"]) {
        const parsed = NotifierConfigSchema.safeParse(json["opencode-telegram-link"]);
        if (parsed.success) return parsed.data;
      }
      if (json["telegram-link"]) {
        const parsed = NotifierConfigSchema.safeParse(json["telegram-link"]);
        if (parsed.success) return parsed.data;
      }
    } catch {}
  }

  // Final fallback: look inside default stateDirectory config or bot token
  try {
    const stateDir = defaultStateDirectory();
    const fallbackPath = join(stateDir, "opencode-notifier.json");
    const content = await readFile(fallbackPath, "utf8");
    const json = JSON.parse(content);
    const parsed = NotifierConfigSchema.safeParse(json);
    if (parsed.success) return parsed.data;
  } catch {}

  try {
    const stateDir = defaultStateDirectory();
    const identityPath = join(stateDir, "telegram-identity.json");
    const content = await readFile(identityPath, "utf8");
    const idJson = JSON.parse(content);
    if (idJson.userId && idJson.chatId) {
      return NotifierConfigSchema.parse({
        mode: "local",
        role: "gateway",
        locale: idJson.locale || "auto",
        telegram: {
          tokenFile: idJson.tokenFile || join(stateDir, "telegram-bot-token"),
          userId: String(idJson.userId),
          chatId: String(idJson.chatId),
        },
        notifications: {
          completion: true,
          error: true,
          question: true,
          permission: true,
        },
      });
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
      existingJson = parseJsonc<Record<string, unknown>>(existingContent);
    } catch (parseErr) {
      throw new Error(
        `Failed to parse existing OpenCode config at ${targetPath}: ${(parseErr as Error).message}. Preserving file to prevent data loss.`,
      );
    }
    // Create backup of existing file
    backupPath = `${targetPath}.bak`;
    await copyFile(targetPath, backupPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist yet, create its parent directory
      await mkdir(dirname(targetPath), { recursive: true });
    } else {
      throw err;
    }
  }

  // Merge plugin config while preserving existing plugins
  const pluginConfig: Record<string, unknown> = {
    mode: config.mode,
    role: config.role,
    ...(config.hostLabel ? { hostLabel: config.hostLabel } : {}),
    locale: config.locale,
    notifications: {
      completion: config.notifications.completion,
      error: config.notifications.error,
      question: config.notifications.question,
      permission: config.notifications.permission,
    },
  };
  if (config.role === "node" && config.gateway) {
    pluginConfig.gateway = {
      url: config.gateway.url,
      secret: config.gateway.secret,
    };
  } else if (config.telegram) {
    pluginConfig.telegram = {
      tokenFile: config.telegram.tokenFile,
      userId: config.telegram.userId,
      chatId: config.telegram.chatId,
    };
  }

  const isMatch = (entry: unknown): boolean => {
    if (typeof entry === "string") {
      return entry === "opencode-telegram-link" || entry.endsWith("opencode-telegram-link");
    }
    if (Array.isArray(entry) && typeof entry[0] === "string") {
      return entry[0] === "opencode-telegram-link" || entry[0].endsWith("opencode-telegram-link");
    }
    return false;
  };

  if (Array.isArray(existingJson.plugin)) {
    const tuple = ["opencode-telegram-link", pluginConfig];
    const index = existingJson.plugin.findIndex(isMatch);
    if (index >= 0) {
      existingJson.plugin[index] = tuple;
    } else {
      existingJson.plugin.push(tuple);
    }
  } else if (Array.isArray(existingJson.plugins)) {
    if (!existingJson.plugins.includes("opencode-telegram-link")) {
      existingJson.plugins.push("opencode-telegram-link");
    }
    const existingPluginMap =
      existingJson.plugin && typeof existingJson.plugin === "object"
        ? (existingJson.plugin as Record<string, unknown>)
        : {};
    existingPluginMap["opencode-telegram-link"] = pluginConfig;
    existingJson.plugin = existingPluginMap;
  } else if (existingJson.plugin && typeof existingJson.plugin === "object") {
    (existingJson.plugin as Record<string, unknown>)["opencode-telegram-link"] = pluginConfig;
  } else {
    // Standard array tuple format
    existingJson.plugin = [["opencode-telegram-link", pluginConfig]];
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
    const existingJson = parseJsonc<Record<string, unknown>>(existingContent);

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
