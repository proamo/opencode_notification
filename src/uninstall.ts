import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeBroker } from "./broker";
import { runStopCommand } from "./broker/commands";
import type { SupportedLocale } from "./i18n";
import { discoverOpenCodeConfigFiles, removeOpenCodeConfig } from "./opencode";
import { AsyncPromptReader, type InteractiveSetupOptions } from "./setup";
import { defaultStateDirectory, discoveryRecordPath, loadOrCreateStateIdentity } from "./state";

export async function runInteractiveUninstall(
  options: InteractiveSetupOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const reader = new AsyncPromptReader(options.stdin ?? process.stdin);
  const stateDirectory = options.stateDirectory ?? defaultStateDirectory();
  const cwd = options.cwd ?? process.cwd();
  const fetchImpl = options.fetch ?? fetch;

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

  // Step 3: Stop active broker (Native or Docker)
  stdout.write("│\n");
  stdout.write(
    isZh
      ? "◇  [1/4] 正在檢查並停止執行中的 Broker (本機程序或 Docker 容器)...\n"
      : "◇  [1/4] Checking and stopping running Broker (native process or Docker container)...\n",
  );
  try {
    const dockerCmd = process.platform === "win32" ? "docker.exe" : "docker";
    const dockerDown = Bun.spawnSync([dockerCmd, "compose", "down"], { cwd });
    if (dockerDown.exitCode === 0) {
      stdout.write(
        isZh
          ? "│  ✔ Docker Broker 容器已停止並清理。\n"
          : "│  ✔ Docker Broker container stopped and cleaned up.\n",
      );
    }
  } catch {
    // Docker not present or not running
  }
  try {
    const identity = await loadOrCreateStateIdentity(stateDirectory);
    const isRunning = await probeBroker(42617, identity.brokerSecret);
    if (isRunning) {
      await runStopCommand({ stateDirectory, port: 42617 }, { stdout, stderr }, fetchImpl);
      stdout.write(isZh ? "│  ✔ 本機 Broker 已成功停止。\n" : "│  ✔ Local broker stopped.\n");
    } else {
      stdout.write(
        isZh ? "│  ✔ 本機 Broker 未在執行中。\n" : "│  ✔ Local broker is not running.\n",
      );
    }
  } catch {
    stdout.write(
      isZh
        ? "│  ✔ 未找到執行中的本機 Broker 或已停止。\n"
        : "│  ✔ No active local broker found or already stopped.\n",
    );
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
      stdout.write(
        isZh ? "│  ✔ 運作暫存資料庫已清除。\n" : "│  ✔ Operational state database cleared.\n",
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
      stdout.write(isZh ? "│  ✔ Token 檔案已安全刪除。\n" : "│  ✔ Token file securely removed.\n");
    } catch {
      stdout.write(isZh ? "│  - Token 檔案不存在。\n" : "│  - Token file does not exist.\n");
    }

    // Ask if want to remove entire state directory
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
          isZh ? `│  ✔ 金鑰與狀態目錄已完全移除。\n` : `│  ✔ State directory completely removed.\n`,
        );
      } catch {
        // ignore
      }
    }
  }

  stdout.write("│\n");
  stdout.write(
    isZh
      ? "└  🎉 OpenCode Telegram Notifier 已成功移除！\n\n"
      : "└  🎉 OpenCode Telegram Notifier successfully uninstalled!\n\n",
  );

  return 0;
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

  if (argv.includes("--help")) {
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

  return await runInteractiveUninstall({
    stdin: options.stdin,
    stdout,
    stderr,
    fetch: options.fetch,
    cwd: options.cwd,
  });
}
