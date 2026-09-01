import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";

export interface SystemdServiceOptions {
  user?: string;
  home?: string;
  execPath?: string;
  binScript?: string;
  envPath?: string;
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

  return `[Unit]
Description=OpenCode Telegram Gateway & Commander
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${home}
Environment=HOME=${home}
Environment="PATH=${envPath}"
Environment="OPENCODE_TELEGRAM_BROKER_BIND_HOST=0.0.0.0"
ExecStart=${execPath} ${binScript} start --bind-host 0.0.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

export async function installSystemdService(
  options: SystemdServiceOptions = {},
): Promise<{ success: boolean; error?: string }> {
  try {
    const serviceContent = generateSystemdService(options);
    const tmpServicePath = `/tmp/opencode-gateway.${process.pid}.service`;
    await writeFile(tmpServicePath, serviceContent, "utf8");

    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    const cpCmd = isRoot
      ? ["cp", tmpServicePath, "/etc/systemd/system/opencode-gateway.service"]
      : ["sudo", "cp", tmpServicePath, "/etc/systemd/system/opencode-gateway.service"];

    const cpResult = Bun.spawnSync(cpCmd);
    if (cpResult.exitCode !== 0) {
      const err = cpResult.stderr
        ? new TextDecoder().decode(cpResult.stderr)
        : "Failed to copy service file";
      return { success: false, error: err };
    }

    const reloadCmd = isRoot
      ? ["systemctl", "daemon-reload"]
      : ["sudo", "systemctl", "daemon-reload"];
    Bun.spawnSync(reloadCmd);

    const enableCmd = isRoot
      ? ["systemctl", "enable", "--now", "opencode-gateway"]
      : ["sudo", "systemctl", "enable", "--now", "opencode-gateway"];
    const enableResult = Bun.spawnSync(enableCmd);

    if (enableResult.exitCode !== 0) {
      const err = enableResult.stderr
        ? new TextDecoder().decode(enableResult.stderr)
        : "Failed to enable service";
      return { success: false, error: err };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function uninstallSystemdService(): Promise<{
  success: boolean;
  removed: boolean;
  error?: string;
}> {
  const serviceFile = "/etc/systemd/system/opencode-gateway.service";
  if (!existsSync(serviceFile)) {
    return { success: true, removed: false };
  }

  try {
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    const disableCmd = isRoot
      ? ["systemctl", "disable", "--now", "opencode-gateway"]
      : ["sudo", "systemctl", "disable", "--now", "opencode-gateway"];
    Bun.spawnSync(disableCmd);

    const rmCmd = isRoot ? ["rm", "-f", serviceFile] : ["sudo", "rm", "-f", serviceFile];
    Bun.spawnSync(rmCmd);

    const reloadCmd = isRoot
      ? ["systemctl", "daemon-reload"]
      : ["sudo", "systemctl", "daemon-reload"];
    Bun.spawnSync(reloadCmd);

    return { success: true, removed: true };
  } catch (err) {
    return {
      success: false,
      removed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
