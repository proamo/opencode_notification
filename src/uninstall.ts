import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { probeBroker } from "./broker";
import { readPersistedBrokerEndpoint, runStopCommand } from "./broker/commands";
import type { SupportedLocale } from "./i18n";
import { discoverOpenCodeConfigFiles, removeOpenCodeConfig } from "./opencode";
import { uninstallSystemdService } from "./service";
import {
  AsyncPromptReader,
  type InteractiveSetupOptions,
  resolveDockerComposeContext,
} from "./setup";
import { defaultStateDirectory, discoveryRecordPath, loadOrCreateStateIdentity } from "./state";

export async function runInteractiveUninstall(
  options: InteractiveSetupOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const reader = new AsyncPromptReader(options.stdin ?? process.stdin);
  try {
    const stateDirectory = options.stateDirectory ?? defaultStateDirectory();
    const cwd = options.cwd ?? process.cwd();
    const fetchImpl = options.fetch ?? fetch;
    const dockerSpawnSync =
      options.dockerSpawnSync ??
      ((command: string[], spawnOptions?: { cwd?: string; timeout?: number }) =>
        Bun.spawnSync(command, spawnOptions));
    const deployment = await readDeploymentRecord(stateDirectory);
    let deploymentMode = deployment?.mode;

    stdout.write("\n┌  OpenCode Telegram Notifier — Uninstaller / 移除精靈\n│\n");

    // Step 1: Language selection
    stdout.write("◇  Language / 語言:\n");
    stdout.write("│  1) 繁體中文 (zh-TW) [預設/Default]\n");
    stdout.write("│  2) English (en)\n");
    const langChoice = await reader.ask("│  請選擇 / Select [1]: ", stdout, "1");
    const locale: SupportedLocale =
      langChoice === "2" || langChoice.toLowerCase() === "en" ? "en" : "zh-TW";
    const isZh = locale === "zh-TW";

    // Step 2: Confirm uninstall
    stdout.write("│\n");
    const confirm = await reader.ask(
      isZh
        ? "◇  是否確認要解除安裝 OpenCode Telegram Notifier？ [y/N]: "
        : "◇  Are you sure you want to uninstall OpenCode Telegram Notifier? [y/N]: ",
      stdout,
      "N",
    );
    if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
      stdout.write(isZh ? "│  操作已取消。\n└  👋 結束。\n\n" : "│  Aborted.\n└  👋 Done.\n\n");
      return 0;
    }

    if (!deploymentMode) {
      stdout.write(
        isZh
          ? "│\n◇  偵測到舊版安裝。原部署模式為何？\n│  1) Native Gateway [預設]\n│  2) Docker Gateway\n│  3) Node Agent\n"
          : "│\n◇  Legacy installation detected. Which deployment mode was used?\n│  1) Native Gateway [Default]\n│  2) Docker Gateway\n│  3) Node Agent\n",
      );
      const legacyMode = await reader.ask(
        isZh ? "│  請選擇 / Select [1]: " : "│  Select [1]: ",
        stdout,
        "1",
      );
      deploymentMode =
        legacyMode === "2" || legacyMode.toLowerCase().includes("docker")
          ? "docker"
          : legacyMode === "3" || legacyMode.toLowerCase().includes("node")
            ? "node"
            : "native";
    }

    // Step 3: Stop active broker (Native or Docker)
    stdout.write("│\n");
    stdout.write(
      isZh
        ? "◇  [1/4] 正在檢查並停止執行中的 Broker (本機程序或 Docker 容器)...\n"
        : "◇  [1/4] Checking and stopping running Broker (native process or Docker container)...\n",
    );
    const composeContext =
      deploymentMode === "docker" && deployment?.composeFile && deployment.projectDir
        ? existsSync(deployment.composeFile) && existsSync(deployment.projectDir)
          ? { composeFile: deployment.composeFile, projectDir: deployment.projectDir }
          : undefined
        : deploymentMode === "docker" && deployment
          ? undefined
          : resolveDockerComposeContext(cwd);
    if (deploymentMode === "docker" && !composeContext) {
      stderr.write(
        isZh
          ? "✖ 找不到 Docker Compose 設定，無法確認 Broker 已停止。\n"
          : "✖ Docker Compose configuration was not found; cannot confirm Broker shutdown.\n",
      );
      return 1;
    }
    if (composeContext && deploymentMode === "docker") {
      try {
        const dockerCmd = process.platform === "win32" ? "docker.exe" : "docker";
        const composeArgs = [
          dockerCmd,
          "compose",
          "-f",
          composeContext.composeFile,
          "--project-directory",
          composeContext.projectDir,
        ];
        const dockerPs = dockerSpawnSync([...composeArgs, "ps", "-a", "-q"], {
          cwd: composeContext.projectDir,
          timeout: 10_000,
        });
        if (dockerPs.exitCode !== 0) {
          const detail = dockerPs.stderr ? new TextDecoder().decode(dockerPs.stderr).trim() : "";
          stderr.write(
            `${isZh ? "✖ 無法確認 Docker Broker 狀態" : "✖ Could not inspect Docker Broker"}${detail ? `: ${detail}` : ""}\n`,
          );
          return 1;
        }
        if (dockerPs.exitCode === 0) {
          const dockerDown = dockerSpawnSync([...composeArgs, "down"], {
            cwd: composeContext.projectDir,
            timeout: 30_000,
          });
          if (dockerDown.exitCode !== 0) {
            const detail = dockerDown.stderr
              ? new TextDecoder().decode(dockerDown.stderr).trim()
              : "";
            stderr.write(
              `${isZh ? "✖ Docker Broker 停止失敗" : "✖ Failed to stop Docker Broker"}${detail ? `: ${detail}` : ""}\n`,
            );
            return 1;
          }
          const dockerVerify = dockerSpawnSync([...composeArgs, "ps", "-a", "-q"], {
            cwd: composeContext.projectDir,
            timeout: 10_000,
          });
          const remainingIds = dockerVerify.stdout
            ? new TextDecoder().decode(dockerVerify.stdout).trim()
            : "";
          if (dockerVerify.exitCode !== 0 || remainingIds) {
            const detail = dockerVerify.stderr
              ? new TextDecoder().decode(dockerVerify.stderr).trim()
              : "";
            stderr.write(
              `${isZh ? "✖ 無法確認 Docker Broker 已停止" : "✖ Could not confirm Docker Broker shutdown"}${detail ? `: ${detail}` : ""}\n`,
            );
            return 1;
          }
          stdout.write(
            isZh
              ? "│  ✔ Docker Broker 容器已停止並清理。\n"
              : "│  ✔ Docker Broker container stopped and cleaned up.\n",
          );
        }
      } catch (error) {
        stderr.write(
          `${isZh ? "✖ Docker Broker 檢查失敗" : "✖ Failed to inspect Docker Broker"}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
    }
    if (deploymentMode === "native") {
      try {
        const uninstallService = options.uninstallSystemd ?? uninstallSystemdService;
        const systemdResult = await uninstallService();
        if (!systemdResult.success) {
          stderr.write(
            `${isZh ? "✖ Systemd 服務停止失敗" : "✖ Failed to stop systemd service"}${systemdResult.error ? `: ${systemdResult.error}` : ""}\n`,
          );
          return 1;
        }
        if (systemdResult.removed) {
          stdout.write(
            isZh
              ? "│  ✔ Systemd 服務 (opencode-gateway.service) 已停用並移除。\n"
              : "│  ✔ Systemd service (opencode-gateway.service) stopped and removed.\n",
          );
        }
      } catch (error) {
        stderr.write(
          `${isZh ? "✖ Systemd 服務檢查失敗" : "✖ Failed to inspect systemd service"}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
      try {
        const identity = await loadOrCreateStateIdentity(stateDirectory);
        const endpoint = (await readPersistedBrokerEndpoint(stateDirectory)) ?? {
          bindHost: "127.0.0.1",
          port: 42617,
        };
        const isRunning = await probeBroker(
          endpoint.port,
          identity.brokerSecret,
          endpoint.bindHost,
        );
        if (isRunning) {
          const stopStatus = await runStopCommand(
            { stateDirectory, port: endpoint.port, bindHost: endpoint.bindHost },
            { stdout, stderr },
            fetchImpl,
          );
          if (stopStatus !== 0)
            throw new Error("broker stop command did not complete successfully");
          stdout.write(isZh ? "│  ✔ 本機 Broker 已成功停止。\n" : "│  ✔ Local broker stopped.\n");
        } else {
          stdout.write(
            isZh ? "│  ✔ 本機 Broker 未在執行中。\n" : "│  ✔ Local broker is not running.\n",
          );
        }
      } catch (error) {
        stderr.write(
          `${isZh ? "✖ 無法確認本機 Broker 已停止" : "✖ Could not confirm local broker shutdown"}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
    }

    // Step 4: Clean OpenCode config files
    stdout.write("│\n");
    stdout.write(
      isZh
        ? "◇  [2/4] 正在搜尋 OpenCode 設定檔...\n"
        : "◇  [2/4] Searching for OpenCode configuration files...\n",
    );
    const discoveredConfigs = await discoverOpenCodeConfigFiles(cwd);
    const existingConfigs = discoveredConfigs.filter((c) => c.exists);

    if (existingConfigs.length > 0) {
      const cleanConfig = await reader.ask(
        isZh
          ? `│  找到 ${existingConfigs.length} 個設定檔，是否從中移除外掛設定？ [Y/n]: `
          : `│  Found ${existingConfigs.length} config file(s). Remove plugin configuration? [Y/n]: `,
        stdout,
        "Y",
      );
      if (cleanConfig.toLowerCase() !== "n" && cleanConfig.toLowerCase() !== "no") {
        for (const config of existingConfigs) {
          const { modified, backupPath } = await removeOpenCodeConfig(config.path);
          if (modified) {
            stdout.write(
              isZh
                ? `│  ✔ 已從 ${config.path} 移除外掛設定${backupPath ? ` (備份於 ${backupPath})` : ""}\n`
                : `│  ✔ Removed plugin config from ${config.path}${backupPath ? ` (backup at ${backupPath})` : ""}\n`,
            );
          } else {
            stdout.write(
              isZh
                ? `│  - ${config.path} 未包含本外掛設定。\n`
                : `│  - No plugin config in ${config.path}.\n`,
            );
          }
        }
      }
      // Clean any lingering npm link node_modules symlinks
      const symlinkLocations = [
        join(cwd, "node_modules", "opencode-telegram-link"),
        join(homedir(), ".config", "opencode", "node_modules", "opencode-telegram-link"),
        join(homedir(), ".opencode", "node_modules", "opencode-telegram-link"),
      ];
      for (const symlink of symlinkLocations) {
        try {
          await rm(symlink, { recursive: true, force: true });
        } catch {}
      }
    } else {
      stdout.write(
        isZh
          ? "│  ✔ 未找到任何 opencode.json 設定檔。\n"
          : "│  ✔ No opencode.json configuration files found.\n",
      );
    }

    if (deploymentMode !== "node") {
      // Step 5: Clean SQLite operational state
      stdout.write("│\n");
      const cleanState = await reader.ask(
        isZh
          ? "◇  [3/4] 是否清除運作暫存資料庫與訊息路由狀態 (SQLite)？ [Y/n]: "
          : "◇  [3/4] Remove operational database & message routing state (SQLite)? [Y/n]: ",
        stdout,
        "Y",
      );
      if (cleanState.toLowerCase() !== "n" && cleanState.toLowerCase() !== "no") {
        try {
          const dbPath = join(stateDirectory, "state.sqlite");
          await rm(dbPath, { force: true });
          await rm(`${dbPath}-wal`, { force: true });
          await rm(`${dbPath}-shm`, { force: true });
          await rm(discoveryRecordPath(stateDirectory), { force: true });
          await rm(join(stateDirectory, "dashboard-settings.json"), { force: true });
          try {
            await rm(join(tmpdir(), "opencode_telegram_plugin.log"), { force: true });
          } catch {}
          stdout.write(
            isZh
              ? "│  ✔ 運作暫存資料庫與控制台設定檔 (dashboard-settings.json) 已清除。\n"
              : "│  ✔ Operational state database & dashboard settings cleared.\n",
          );
        } catch {
          stdout.write(
            isZh
              ? "│  - 暫存資料庫不存在或已清理。\n"
              : "│  - State database not found or already clean.\n",
          );
        }
      }

      // Step 6: Delete Telegram Bot Token file
      stdout.write("│\n");
      const cleanToken = await reader.ask(
        isZh
          ? "◇  [4/4] 是否刪除儲存的 Telegram Bot Token 檔案？ [y/N]: "
          : "◇  [4/4] Delete saved Telegram Bot Token file? [y/N]: ",
        stdout,
        "N",
      );
      if (cleanToken.toLowerCase() === "y" || cleanToken.toLowerCase() === "yes") {
        try {
          const tokenPath = join(stateDirectory, "telegram-bot-token");
          await rm(tokenPath, { force: true });
          stdout.write(
            isZh ? "│  ✔ Token 檔案已安全刪除。\n" : "│  ✔ Token file securely removed.\n",
          );
        } catch {
          stdout.write(isZh ? "│  - Token 檔案不存在。\n" : "│  - Token file does not exist.\n");
        }

        const cleanAll = await reader.ask(
          isZh
            ? `│  是否連同金鑰目錄 ${stateDirectory} 一併完全刪除？ [y/N]: `
            : `│  Delete entire state directory (${stateDirectory})? [y/N]: `,
          stdout,
          "N",
        );
        if (cleanAll.toLowerCase() === "y" || cleanAll.toLowerCase() === "yes") {
          try {
            await rm(stateDirectory, { recursive: true, force: true });
            stdout.write(
              isZh
                ? `│  ✔ 金鑰與狀態目錄已完全移除。\n`
                : `│  ✔ State directory completely removed.\n`,
            );
          } catch {}
        }
      }
    } else {
      stdout.write(
        isZh
          ? "│  ✔ Node移除不會刪除Gateway資料庫、Token或共享狀態目錄。\n"
          : "│  ✔ Node uninstall preserves Gateway databases, tokens, and shared state directories.\n",
      );
    }

    stdout.write("│\n");
    stdout.write(
      isZh
        ? "└  🎉 OpenCode Telegram Notifier 已成功移除！\n\n"
        : "└  🎉 OpenCode Telegram Notifier successfully uninstalled!\n\n",
    );

    return 0;
  } finally {
    reader.close();
  }
}

export async function runUninstallCli(
  options: {
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    stdout?: Pick<NodeJS.WriteStream, "write">;
    stderr?: Pick<NodeJS.WriteStream, "write">;
    stdin?: AsyncIterable<Buffer | string>;
    fetch?: typeof fetch;
    cwd?: string;
  } = {},
): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(
      `Usage: opencode-telegram-broker uninstall [options]

Interactively and safely uninstall OpenCode Telegram Link.

Options:
  -h, --help            Show this help text
  -i, --interactive     Force interactive mode (default)
  --state-dir <path>    Override state directory
`,
    );
    return 0;
  }

  let stateDirectory: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "-i" || flag === "--interactive") continue;
    if (flag === "--state-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        stderr.write("--state-dir requires a path\n");
        return 2;
      }
      stateDirectory = value;
      index += 1;
      continue;
    }
    stderr.write(`Unknown uninstall option: ${flag}\n`);
    return 2;
  }

  return await runInteractiveUninstall({
    stdin: options.stdin,
    stdout,
    stderr,
    fetch: options.fetch,
    cwd: options.cwd,
    stateDirectory,
  });
}

type DeploymentRecord = {
  mode: "native" | "docker" | "node";
  composeFile?: string;
  projectDir?: string;
};

async function readDeploymentRecord(stateDirectory: string): Promise<DeploymentRecord | undefined> {
  const path = join(stateDirectory, "deployment.json");
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    mode?: unknown;
    composeFile?: unknown;
    projectDir?: unknown;
  };
  if (parsed.mode !== "native" && parsed.mode !== "docker" && parsed.mode !== "node") {
    throw new Error("persisted deployment mode is invalid");
  }
  if (parsed.mode !== "docker") return { mode: parsed.mode };
  if (parsed.composeFile === undefined && parsed.projectDir === undefined)
    return { mode: "docker" };
  if (
    typeof parsed.composeFile !== "string" ||
    typeof parsed.projectDir !== "string" ||
    !isAbsolute(parsed.composeFile) ||
    !isAbsolute(parsed.projectDir)
  ) {
    throw new Error("persisted Docker Compose ownership is invalid");
  }
  return { mode: "docker", composeFile: parsed.composeFile, projectDir: parsed.projectDir };
}
