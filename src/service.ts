import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SystemdServiceOptions {
  user?: string | undefined;
  home?: string | undefined;
  execPath?: string | undefined;
  binScript?: string | undefined;
  envPath?: string | undefined;
  bindHost?: string | undefined;
  stateDirectory?: string | undefined;
  xdgStateHome?: string | undefined;
  xdgConfigHome?: string | undefined;
  serviceFile?: string | undefined;
  spawnSync?: ((command: string[]) => { exitCode: number; stderr?: Uint8Array }) | undefined;
}

export function isSystemdAvailable(): boolean {
  if (platform() !== "linux") return false;
  try {
    const result = Bun.spawnSync(["systemctl", "--version"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export function generateSystemdService(options: SystemdServiceOptions = {}): string {
  const user = options.user || process.env.USER || "root";
  const home = options.home || process.env.HOME || homedir();
  const envPath =
    options.envPath ||
    process.env.PATH ||
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  const execPath = options.execPath || process.execPath;
  const binScript = options.binScript || process.argv[1] || "opencode-telegram-link";
  const bindHost = options.bindHost || "127.0.0.1";
  const stateDirectory = options.stateDirectory;
  const environment = [
    `Environment=${quoteSystemd(`HOME=${home}`)}`,
    `Environment=${quoteSystemd(`PATH=${envPath}`)}`,
    `Environment=${quoteSystemd(`OPENCODE_TELEGRAM_BROKER_BIND_HOST=${bindHost}`)}`,
    ...(stateDirectory
      ? [`Environment=${quoteSystemd(`OPENCODE_TELEGRAM_BROKER_STATE_DIR=${stateDirectory}`)}`]
      : []),
    ...(options.xdgStateHome
      ? [`Environment=${quoteSystemd(`XDG_STATE_HOME=${options.xdgStateHome}`)}`]
      : []),
    ...(options.xdgConfigHome
      ? [`Environment=${quoteSystemd(`XDG_CONFIG_HOME=${options.xdgConfigHome}`)}`]
      : []),
  ].join("\n");

  if (!/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(user)) {
    throw new Error("systemd user contains unsupported characters");
  }

  return `[Unit]
Description=OpenCode Telegram Gateway & Commander
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${escapeSystemdPath(home)}
${environment}
ExecStart=${quoteSystemd(execPath)} ${quoteSystemd(binScript)} start --bind-host ${quoteSystemd(bindHost)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

export async function installSystemdService(
  options: SystemdServiceOptions = {},
): Promise<{ success: boolean; error?: string }> {
  try {
    const spawnSync = options.spawnSync ?? ((command: string[]) => Bun.spawnSync(command));
    const stateDirectory =
      options.stateDirectory ?? join(homedir(), ".local", "state", "opencode-telegram-link");
    const serviceDirectory = join(stateDirectory, "service");
    await mkdir(serviceDirectory, { recursive: true, mode: 0o700 });
    const sourceEntry = resolveBrokerEntry();
    const installedEntry = join(serviceDirectory, "opencode-telegram-broker.js");
    const temporaryEntry = `${installedEntry}.${process.pid}.tmp`;
    await copyFile(sourceEntry, temporaryEntry);
    await chmod(temporaryEntry, 0o600);

    const serviceContent = generateSystemdService({
      ...options,
      stateDirectory,
      binScript: installedEntry,
      ...((options.xdgStateHome ?? process.env.XDG_STATE_HOME)
        ? { xdgStateHome: options.xdgStateHome ?? process.env.XDG_STATE_HOME }
        : {}),
      ...((options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME)
        ? { xdgConfigHome: options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME }
        : {}),
    });
    const tmpServicePath = join(serviceDirectory, `opencode-gateway.${process.pid}.service`);
    await writeFile(tmpServicePath, serviceContent, "utf8");
    await chmod(tmpServicePath, 0o644);

    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    const serviceFile = options.serviceFile ?? "/etc/systemd/system/opencode-gateway.service";
    const previousServiceFile = join(serviceDirectory, "opencode-gateway.previous.service");
    const hadServiceFile = existsSync(serviceFile);
    const wasEnabled =
      hadServiceFile &&
      spawnSync(
        isRoot
          ? ["systemctl", "is-enabled", "opencode-gateway"]
          : ["sudo", "systemctl", "is-enabled", "opencode-gateway"],
      ).exitCode === 0;
    if (hadServiceFile) await copyFile(serviceFile, previousServiceFile);
    const cpCmd = isRoot
      ? ["cp", tmpServicePath, serviceFile]
      : ["sudo", "cp", tmpServicePath, serviceFile];

    const cpResult = spawnSync(cpCmd);
    if (cpResult.exitCode !== 0) {
      const err = cpResult.stderr
        ? new TextDecoder().decode(cpResult.stderr)
        : "Failed to copy service file";
      await rm(tmpServicePath, { force: true });
      await rm(temporaryEntry, { force: true });
      await rm(previousServiceFile, { force: true });
      return { success: false, error: err.trim() };
    }

    const reloadCmd = isRoot
      ? ["systemctl", "daemon-reload"]
      : ["sudo", "systemctl", "daemon-reload"];
    const reloadResult = spawnSync(reloadCmd);
    if (reloadResult.exitCode !== 0) {
      const rollbackError = rollbackSystemdUnit(
        spawnSync,
        isRoot,
        serviceFile,
        previousServiceFile,
        hadServiceFile,
        wasEnabled,
      );
      await rm(tmpServicePath, { force: true });
      await rm(temporaryEntry, { force: true });
      await rm(previousServiceFile, { force: true });
      return {
        success: false,
        error: withRollbackError(
          decodeSpawnError(reloadResult, "Failed to reload systemd"),
          rollbackError,
        ),
      };
    }

    const enableCmd = isRoot
      ? ["systemctl", "enable", "opencode-gateway"]
      : ["sudo", "systemctl", "enable", "opencode-gateway"];
    const enableResult = spawnSync(enableCmd);

    if (enableResult.exitCode !== 0) {
      const err = enableResult.stderr
        ? new TextDecoder().decode(enableResult.stderr)
        : "Failed to enable service";
      const rollbackError = rollbackSystemdUnit(
        spawnSync,
        isRoot,
        serviceFile,
        previousServiceFile,
        hadServiceFile,
        wasEnabled,
      );
      await rm(tmpServicePath, { force: true });
      await rm(temporaryEntry, { force: true });
      await rm(previousServiceFile, { force: true });
      return { success: false, error: withRollbackError(err.trim(), rollbackError) };
    }

    const backupEntry = `${installedEntry}.previous`;
    const hadInstalledEntry = existsSync(installedEntry);
    if (hadInstalledEntry) await copyFile(installedEntry, backupEntry);
    await rename(temporaryEntry, installedEntry);

    const restartCmd = isRoot
      ? ["systemctl", "restart", "opencode-gateway"]
      : ["sudo", "systemctl", "restart", "opencode-gateway"];
    const restartResult = spawnSync(restartCmd);
    const activeCmd = isRoot
      ? ["systemctl", "is-active", "--quiet", "opencode-gateway"]
      : ["sudo", "systemctl", "is-active", "--quiet", "opencode-gateway"];
    const activeResult = restartResult.exitCode === 0 ? spawnSync(activeCmd) : undefined;
    if (restartResult.exitCode !== 0 || activeResult?.exitCode !== 0) {
      if (hadInstalledEntry) await rename(backupEntry, installedEntry);
      else await rm(installedEntry, { force: true });
      const rollbackError = rollbackSystemdUnit(
        spawnSync,
        isRoot,
        serviceFile,
        previousServiceFile,
        hadServiceFile,
        wasEnabled,
      );
      const recoveryRestart = hadServiceFile ? spawnSync(restartCmd) : undefined;
      await rm(tmpServicePath, { force: true });
      await rm(previousServiceFile, { force: true });
      return {
        success: false,
        error: withRollbackError(
          restartResult.exitCode !== 0
            ? decodeSpawnError(restartResult, "Failed to restart systemd service")
            : decodeSpawnError(activeResult ?? {}, "Systemd service did not remain active"),
          rollbackError ??
            (recoveryRestart && recoveryRestart.exitCode !== 0
              ? decodeSpawnError(recoveryRestart, "Failed to restart restored systemd service")
              : undefined),
        ),
      };
    }

    await rm(backupEntry, { force: true });
    await rm(previousServiceFile, { force: true });
    await rm(tmpServicePath, { force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function uninstallSystemdService(options: SystemdServiceOptions = {}): Promise<{
  success: boolean;
  removed: boolean;
  error?: string;
}> {
  const serviceFile = options.serviceFile ?? "/etc/systemd/system/opencode-gateway.service";
  if (!existsSync(serviceFile)) {
    return { success: true, removed: false };
  }

  try {
    const spawnSync = options.spawnSync ?? ((command: string[]) => Bun.spawnSync(command));
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    const disableCmd = isRoot
      ? ["systemctl", "disable", "--now", "opencode-gateway"]
      : ["sudo", "systemctl", "disable", "--now", "opencode-gateway"];
    const disableResult = spawnSync(disableCmd);
    if (disableResult.exitCode !== 0) {
      return {
        success: false,
        removed: false,
        error: decodeSpawnError(disableResult, "Failed to disable systemd service"),
      };
    }

    const rmCmd = isRoot ? ["rm", "-f", serviceFile] : ["sudo", "rm", "-f", serviceFile];
    const removeResult = spawnSync(rmCmd);
    if (removeResult.exitCode !== 0) {
      return {
        success: false,
        removed: false,
        error: decodeSpawnError(removeResult, "Failed to remove systemd service"),
      };
    }

    const reloadCmd = isRoot
      ? ["systemctl", "daemon-reload"]
      : ["sudo", "systemctl", "daemon-reload"];
    const reloadResult = spawnSync(reloadCmd);
    if (reloadResult.exitCode !== 0) {
      return {
        success: false,
        removed: true,
        error: decodeSpawnError(reloadResult, "Failed to reload systemd"),
      };
    }

    return { success: true, removed: true };
  } catch (err) {
    return {
      success: false,
      removed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function quoteSystemd(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new Error("systemd value contains a forbidden character");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeSystemdPath(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new Error("systemd path contains a forbidden character");
  return value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\x5c")
    .replaceAll(" ", "\\x20")
    .replaceAll("\t", "\\x09");
}

function resolveBrokerEntry(): string {
  const current = resolve(process.argv[1] ?? "");
  if (current.endsWith(join("dist", "broker", "main.js")) && existsSync(current)) return current;
  const built = resolve(dirname(import.meta.path), "..", "dist", "broker", "main.js");
  if (existsSync(built)) return built;
  throw new Error(
    "built broker entry was not found; run setup from the published package or after build",
  );
}

function decodeSpawnError(result: { stderr?: Uint8Array }, fallback: string): string {
  const detail = result.stderr ? new TextDecoder().decode(result.stderr).trim() : "";
  return detail || fallback;
}

function rollbackSystemdUnit(
  spawnSync: (command: string[]) => { exitCode: number; stderr?: Uint8Array },
  isRoot: boolean,
  serviceFile: string,
  previousServiceFile: string,
  hadServiceFile: boolean,
  wasEnabled: boolean,
): string | undefined {
  const disableResult = wasEnabled
    ? undefined
    : spawnSync(
        isRoot
          ? ["systemctl", "disable", "opencode-gateway"]
          : ["sudo", "systemctl", "disable", "opencode-gateway"],
      );
  const command = hadServiceFile
    ? isRoot
      ? ["cp", previousServiceFile, serviceFile]
      : ["sudo", "cp", previousServiceFile, serviceFile]
    : isRoot
      ? ["rm", "-f", serviceFile]
      : ["sudo", "rm", "-f", serviceFile];
  const restoreResult = spawnSync(command);
  const reloadResult = spawnSync(
    isRoot ? ["systemctl", "daemon-reload"] : ["sudo", "systemctl", "daemon-reload"],
  );
  const enableResult = wasEnabled
    ? spawnSync(
        isRoot
          ? ["systemctl", "enable", "opencode-gateway"]
          : ["sudo", "systemctl", "enable", "opencode-gateway"],
      )
    : undefined;
  if (disableResult && disableResult.exitCode !== 0) {
    return decodeSpawnError(disableResult, "Failed to restore disabled systemd state");
  }
  if (restoreResult.exitCode !== 0) {
    return decodeSpawnError(restoreResult, "Failed to restore systemd unit");
  }
  if (reloadResult.exitCode !== 0) {
    return decodeSpawnError(reloadResult, "Failed to reload restored systemd unit");
  }
  if (enableResult && enableResult.exitCode !== 0) {
    return decodeSpawnError(enableResult, "Failed to restore enabled systemd state");
  }
  return undefined;
}

function withRollbackError(error: string, rollbackError?: string): string {
  return rollbackError ? `${error}; rollback failed: ${rollbackError}` : error;
}
