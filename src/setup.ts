import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { type NotifierConfig, NotifierConfigSchema } from "./config";
import type { SupportedLocale } from "./i18n";
import {
  discoverOpenCodeConfigFiles,
  generatePluginConfigSnippet,
  injectOpenCodeConfig,
} from "./opencode";
import { defaultStateDirectory } from "./state";
import { type TelegramBot, TelegramBotApi, type TelegramUpdate } from "./telegram/api";

export type PairingCandidate = {
  userId: string;
  chatId: string;
  updateId: number;
};

export type GuidedSetupResult =
  | {
      status: "ready";
      bot: Pick<TelegramBot, "id" | "username">;
      config: NotifierConfig;
      tokenFile: string;
      readyForTestNotification: true;
      pairing?: PairingCandidate;
    }
  | {
      status: "confirmation_required";
      bot: Pick<TelegramBot, "id" | "username">;
      nonce: string;
      expiresAt: number;
      pairing: PairingCandidate;
    };

export type GuidedSetupOptions = {
  botToken: string;
  locale?: SupportedLocale;
  userId?: string;
  chatId?: string;
  stateDirectory?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  pairing?: {
    enabled: true;
    nonce?: string;
    expiresInMs?: number;
    pollTimeoutSeconds?: number;
    confirm?: (candidate: PairingCandidate) => boolean | Promise<boolean>;
  };
};

export type InteractiveSetupOptions = {
  stdin?: AsyncIterable<Buffer | string> | NodeJS.ReadableStream | undefined;
  stdout?: Pick<NodeJS.WriteStream, "write"> | undefined;
  stderr?: Pick<NodeJS.WriteStream, "write"> | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fetch?: typeof fetch | undefined;
  stateDirectory?: string | undefined;
  cwd?: string | undefined;
  now?: (() => number) | undefined;
};

export class SetupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SetupError";
    this.code = code;
  }
}

export class AsyncPromptReader {
  private iterator: AsyncIterator<Buffer | string>;
  private buffer = "";

  constructor(input: AsyncIterable<Buffer | string> | NodeJS.ReadableStream) {
    this.iterator = (input as AsyncIterable<Buffer | string>)[Symbol.asyncIterator]();
  }

  async readLine(): Promise<string> {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        return line.replace(/\r$/, "");
      }
      const { value, done } = await this.iterator.next();
      if (done) {
        const remaining = this.buffer;
        this.buffer = "";
        return remaining.replace(/\r$/, "");
      }
      this.buffer += String(value);
    }
  }

  async ask(
    promptText: string,
    stdout: Pick<NodeJS.WriteStream, "write">,
    defaultValue?: string,
  ): Promise<string> {
    stdout.write(promptText);
    const line = (await this.readLine()).trim();
    if (!line && defaultValue !== undefined) {
      return defaultValue;
    }
    return line;
  }
}

export async function runGuidedSetup(options: GuidedSetupOptions): Promise<GuidedSetupResult> {
  const now = options.now ?? Date.now;
  const stateDirectory = options.stateDirectory ?? defaultStateDirectory();
  const tokenFile = join(stateDirectory, "telegram-bot-token");
  const api = new TelegramBotApi({
    token: options.botToken,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const bot = await api.getMe();
  const locale = options.locale ?? "en";

  let userId = options.userId;
  let chatId = options.chatId;
  let pairing: PairingCandidate | undefined;

  if (options.pairing?.enabled) {
    if (!options.pairing.nonce && !options.pairing.confirm) {
      throw new SetupError(
        "PAIRING_NONCE_REQUIRED",
        "pairing requires a nonce when local confirmation is handled by the caller",
      );
    }
    const nonce = options.pairing.nonce ?? createPairingNonce();
    const expiresAt = now() + (options.pairing.expiresInMs ?? 2 * 60_000);
    pairing = await waitForPairingMessage(api, {
      nonce,
      expiresAt,
      now,
      pollTimeoutSeconds: options.pairing.pollTimeoutSeconds ?? 5,
    });
    if (!options.pairing.confirm) {
      return { status: "confirmation_required", bot: publicBot(bot), nonce, expiresAt, pairing };
    }
    if (!(await options.pairing.confirm(pairing))) {
      throw new SetupError("PAIRING_NOT_CONFIRMED", "pairing was not confirmed locally");
    }
    userId = pairing.userId;
    chatId = pairing.chatId;
  }

  if (!userId || !chatId) {
    throw new SetupError("SETUP_IDENTITY_MISSING", "Telegram userId and chatId are required");
  }

  const parsed = NotifierConfigSchema.safeParse({
    locale,
    telegram: { tokenFile, userId, chatId },
  });
  if (!parsed.success) {
    throw new SetupError("SETUP_CONFIGURATION_INVALID", sanitizedConfigError(parsed.error.issues));
  }

  await writePrivateTokenFile(stateDirectory, tokenFile, options.botToken);

  return {
    status: "ready",
    bot: publicBot(bot),
    config: parsed.data,
    tokenFile,
    readyForTestNotification: true,
    ...(pairing ? { pairing } : {}),
  };
}

export async function runInteractiveSetup(options: InteractiveSetupOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const fetchImpl = options.fetch ?? fetch;
  const reader = new AsyncPromptReader(options.stdin ?? process.stdin);
  const now = options.now ?? Date.now;
  const stateDirectory = options.stateDirectory ?? defaultStateDirectory();
  const cwd = options.cwd ?? process.cwd();

  stdout.write("\n┌  OpenCode Telegram Notifier — Setup Wizard\n│\n");

  // Step 1: Language / 語言
  stdout.write("◇  Language / 語言:\n");
  stdout.write("│  1) 繁體中文 (zh-TW) [預設/Default]\n");
  stdout.write("│  2) English (en)\n");
  const langChoice = await reader.ask("│  請選擇 / Select [1]: ", stdout, "1");
  const locale: SupportedLocale =
    langChoice === "2" || langChoice.toLowerCase() === "en" ? "en" : "zh-TW";
  const isZh = locale === "zh-TW";

  // Step 2: Role Selection
  stdout.write("│\n");
  stdout.write(
    isZh
      ? "◇  請選擇此機器的角色 (Role):\n│  1) 獨立 Gateway 模式 (Gateway Mode) [預設/Default] — 擁有專屬 Telegram Bot，可供本機與其他節點連線\n│  2) 節點 Agent 模式 (Node Agent Mode) — 連線至現有的 Gateway，共用 Telegram Bot\n"
      : "◇  Select machine role:\n│  1) Standalone Gateway Mode [Default] — Owns a Telegram Bot, serves local and remote nodes\n│  2) Node Agent Mode — Connects to an existing Gateway, shares Telegram Bot\n",
  );
  const roleChoice = await reader.ask(
    isZh ? "│  請選擇 / Select [1]: " : "│  Select [1]: ",
    stdout,
    "1",
  );
  const isNode = roleChoice === "2" || roleChoice.toLowerCase().includes("node");

  // Step 3: Host Label
  const defaultHost = hostname() || "host";
  stdout.write("│\n");
  stdout.write(
    isZh
      ? `◇  主機識別標籤 (Host Label) [預設: ${defaultHost}]:\n│  (此標籤將顯示於 Telegram 通知頂部，便於識別來源主機)\n`
      : `◇  Host Label [Default: ${defaultHost}]:\n│  (Shown in notification header to identify this machine)\n`,
  );
  const hostLabel = await reader.ask(
    isZh ? `│  標籤名稱 [${defaultHost}]: ` : `│  Label [${defaultHost}]: `,
    stdout,
    defaultHost,
  );

  let configData: NotifierConfig;
  let isDocker = false;
  let pairing: PairingCandidate | undefined;
  let api: TelegramBotApi | undefined;
  let botInfo: TelegramBot | undefined;

  if (isNode) {
    stdout.write("│\n");
    stdout.write(
      isZh
        ? "◇  請輸入 Central Gateway 的 WebSocket 位址:\n│  (範例: ws://192.168.1.100:42617 或 wss://gateway.example.com)\n"
        : "◇  Enter Central Gateway WebSocket URL:\n│  (Example: ws://192.168.1.100:42617 or wss://gateway.example.com)\n",
    );
    const gatewayUrl = await reader.ask("│  Gateway URL: ", stdout);
    if (!gatewayUrl) {
      stderr.write(isZh ? "✖ Gateway URL 不能為空。\n" : "✖ Gateway URL cannot be empty.\n");
      return 1;
    }

    stdout.write("│\n");
    stdout.write(
      isZh
        ? "◇  請輸入 Gateway 連線金鑰 (Secret Token):\n│  (若 Gateway 無需金鑰可直接按 Enter)\n"
        : "◇  Enter Gateway Secret Token:\n│  (Press Enter if no secret required)\n",
    );
    const gatewaySecret = await reader.ask("│  Secret: ", stdout, "");

    configData = {
      mode: "local",
      role: "node",
      hostLabel,
      locale,
      gateway: {
        url: gatewayUrl,
        secret: gatewaySecret || "default-secret",
      },
      notifications: {
        completion: true,
        error: true,
        question: true,
        permission: true,
        includeChildLifecycle: false,
        completionDebounceMs: 1500,
        pluginBufferSize: 100,
      },
      broker: {
        host: "127.0.0.1",
        port: 42617,
      },
      interaction: {
        sessionPromptTtlMinutes: 1440,
        questionTtlMinutes: 30,
      },
    };
  } else {
    // Gateway mode
    // Deployment Mode
    stdout.write("│\n");
    stdout.write(
      isZh
        ? "◇  部署模式選擇 / Deployment Mode:\n│  1) 本機原生模式 (Native Mode) [預設/Default] — Broker 作為本機常駐程序，OpenCode 自動在背景拉起\n│  2) Docker 容器模式 (Docker Container) — Broker 隔離於 Docker 容器中執行\n"
        : "◇  Deployment Mode:\n│  1) Native Mode [Default] — Broker runs as a local background process, auto-spawned by OpenCode\n│  2) Docker Container Mode — Broker runs isolated inside a Docker container\n",
    );
    const modeChoice = await reader.ask(
      isZh ? "│  請選擇 / Select [1]: " : "│  Select [1]: ",
      stdout,
      "1",
    );
    isDocker = modeChoice === "2" || modeChoice.toLowerCase().includes("docker");

    // BotFather Token
    let botToken = "";
    let attempts = 0;
    while (!botInfo) {
      attempts += 1;
      if (attempts > 5) {
        stderr.write(isZh ? "✖ 超過重試次數，設定終止。\n" : "✖ Too many attempts. Aborted.\n");
        return 1;
      }
      stdout.write("│\n");
      if (isZh) {
        stdout.write("◇  請輸入向 @BotFather 申請的 Telegram Bot Token:\n");
        stdout.write("│  (範例: 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ)\n");
      } else {
        stdout.write("◇  Enter your Telegram Bot Token from @BotFather:\n");
        stdout.write("│  (Example: 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ)\n");
      }
      botToken = await reader.ask("│  Token: ", stdout);
      if (!botToken) {
        stdout.write(
          isZh ? "│  ✖ Token 不能為空，請重新輸入。\n" : "│  ✖ Token cannot be empty.\n",
        );
        continue;
      }
      if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
        stdout.write(
          isZh
            ? "│  ✖ Token 格式不符合 Telegram 規範，請重新輸入。\n"
            : "│  ✖ Invalid token format.\n",
        );
        continue;
      }
      stdout.write(
        isZh
          ? "│  ⠋ 正在向 Telegram 驗證 Bot Token...\n"
          : "│  ⠋ Verifying Bot Token with Telegram...\n",
      );
      api = new TelegramBotApi({ token: botToken, fetch: fetchImpl });
      try {
        botInfo = await api.getMe();
        const botName = botInfo.username ? `@${botInfo.username}` : `bot ${botInfo.id}`;
        stdout.write(
          isZh
            ? `│  ✔ 連線成功！已辨識 Bot: ${botName} (ID: ${botInfo.id})\n`
            : `│  ✔ Connected! Identified Bot: ${botName} (ID: ${botInfo.id})\n`,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "connection failed";
        stdout.write(
          isZh
            ? `│  ✖ Token 驗證失敗 (${errMsg})，請確認後重試。\n`
            : `│  ✖ Verification failed (${errMsg}). Please retry.\n`,
        );
      }
    }

    // Nonce Pairing
    api = new TelegramBotApi({ token: botToken, fetch: fetchImpl });
    const nonce = createPairingNonce();
    const botName = botInfo.username ? `@${botInfo.username}` : `Bot (ID: ${botInfo.id})`;
    stdout.write("│\n");
    if (isZh) {
      stdout.write("◇  [身分驗證配對]\n");
      stdout.write(`│  請在 Telegram 打開與 ${botName} 的私聊視窗，並發送此驗證碼：\n`);
      stdout.write(`│\n│  👉  ${nonce}\n│\n`);
      stdout.write("│  ⠋ 等待 Telegram 私訊中...\n");
    } else {
      stdout.write("◇  [Identity Pairing]\n");
      stdout.write(`│  Open a private chat with ${botName} on Telegram and send this code:\n`);
      stdout.write(`│\n│  👉  ${nonce}\n│\n`);
      stdout.write("│  ⠋ Waiting for Telegram private message...\n");
    }

    const expiresAt = now() + 120_000;
    try {
      pairing = await waitForPairingMessage(api, {
        nonce,
        expiresAt,
        now,
        pollTimeoutSeconds: 5,
      });
    } catch {
      stdout.write(
        isZh
          ? "│  ✖ 配對超時或未收到有效訊息，設定中止。\n"
          : "│  ✖ Pairing timed out or no valid message received. Aborted.\n",
      );
      return 1;
    }

    stdout.write(
      isZh
        ? `│  ✔ 收到驗證訊息！來自 Telegram 用戶 (ID: ${pairing.userId}, Chat: ${pairing.chatId})\n`
        : `│  ✔ Received pairing message! Telegram User (ID: ${pairing.userId}, Chat: ${pairing.chatId})\n`,
    );

    const confirmBind = await reader.ask(
      isZh
        ? "│  是否將此 Telegram 帳號綁定為 OpenCode 管理員？ [Y/n]: "
        : "│  Authorize this Telegram user for OpenCode notifications & replies? [Y/n]: ",
      stdout,
      "Y",
    );
    if (confirmBind.toLowerCase() === "n" || confirmBind.toLowerCase() === "no") {
      stdout.write(isZh ? "│  ✖ 已取消綁定。\n" : "│  ✖ Pairing cancelled.\n");
      return 1;
    }

    // Write secure token file
    const tokenFile = join(stateDirectory, "telegram-bot-token");
    await writePrivateTokenFile(stateDirectory, tokenFile, botToken);
    const identityFile = join(stateDirectory, "telegram-identity.json");
    await writeFile(
      identityFile,
      `${JSON.stringify({ userId: pairing.userId, chatId: pairing.chatId, tokenFile, locale }, null, 2)}\n`,
      "utf8",
    );
    stdout.write(
      isZh
        ? `│  ✔ 安全 Token 檔案已儲存 (${tokenFile})\n`
        : `│  ✔ Secure token file saved (${tokenFile})\n`,
    );

    configData = {
      mode: "local",
      role: "gateway",
      hostLabel,
      locale,
      telegram: {
        tokenFile,
        userId: pairing.userId,
        chatId: pairing.chatId,
      },
      notifications: {
        completion: true,
        error: true,
        question: true,
        permission: true,
        includeChildLifecycle: false,
        completionDebounceMs: 1500,
        pluginBufferSize: 100,
      },
      broker: {
        host: "127.0.0.1",
        port: 42617,
      },
      interaction: {
        sessionPromptTtlMinutes: 1440,
        questionTtlMinutes: 30,
      },
    };
  }

  // Step 5: OpenCode config detection & injection
  stdout.write("│\n");
  const discovered = await discoverOpenCodeConfigFiles(cwd);
  const existingConfigs = discovered.filter((d) => d.exists);
  const fallback = discovered.find((d) => !d.isWorkspace) ?? discovered[0];
  const targets = existingConfigs.length > 0 ? existingConfigs : fallback ? [fallback] : [];

  if (targets.length > 0) {
    const descList = targets
      .map(
        (t) =>
          `${t.path} [${t.exists ? (isZh ? "已存在" : "existing") : isZh ? "將自動建立" : "will create"}]`,
      )
      .join(", ");
    stdout.write(
      isZh
        ? `◇  偵測到 OpenCode 設定檔 (${descList})\n`
        : `◇  Discovered OpenCode config file(s) (${descList})\n`,
    );
    const autoWrite = await reader.ask(
      isZh
        ? "│  是否自動寫入外掛設定？ [Y/n]: "
        : "│  Automatically update OpenCode config file(s)? [Y/n]: ",
      stdout,
      "Y",
    );
    if (autoWrite.toLowerCase() !== "n" && autoWrite.toLowerCase() !== "no") {
      for (const target of targets) {
        try {
          const { backupPath } = await injectOpenCodeConfig(target.path, configData);
          stdout.write(
            isZh
              ? `│  ✔ OpenCode 設定檔已更新: ${target.path}${backupPath ? ` (備份於 ${backupPath})` : ""}\n`
              : `│  ✔ OpenCode config updated: ${target.path}${backupPath ? ` (backup at ${backupPath})` : ""}\n`,
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : "failed to write config";
          stdout.write(
            isZh
              ? `│  ✖ 設定檔寫入失敗 (${target.path}): ${errMsg}\n`
              : `│  ✖ Failed to write config (${target.path}): ${errMsg}\n`,
          );
        }
      }
    } else {
      stdout.write(
        isZh
          ? "│  請手動將下列設定加入您的 opencode.json:\n"
          : "│  Please add the following configuration to your opencode.json:\n",
      );
      stdout.write(`│\n${generatePluginConfigSnippet(configData)}\n│\n`);
    }
  }

  if (isDocker) {
    stdout.write("│\n");
    const autoStartDocker = await reader.ask(
      isZh
        ? "◇  是否立即在背景自動建置並啟動 Docker Broker 容器？ [Y/n]: "
        : "◇  Build and start Docker Broker container in background now? [Y/n]: ",
      stdout,
      "Y",
    );
    if (autoStartDocker.toLowerCase() !== "n" && autoStartDocker.toLowerCase() !== "no") {
      stdout.write(
        isZh
          ? "│  ⠋ 正在建置並啟動 Docker 容器 (docker compose up -d --build)...\n"
          : "│  ⠋ Building and starting Docker container (docker compose up -d --build)...\n",
      );
      try {
        const dockerCmd = process.platform === "win32" ? "docker.exe" : "docker";
        const result = Bun.spawnSync([dockerCmd, "compose", "up", "-d", "--build"], {
          cwd,
          env: {
            ...process.env,
            HOME: process.env.HOME || process.env.USERPROFILE || "",
          },
        });
        if (result.exitCode === 0) {
          stdout.write(
            isZh
              ? "│  ✔ Docker Broker 容器已成功在背景啟動！\n"
              : "│  ✔ Docker Broker container started in background!\n",
          );
        } else {
          stdout.write(
            isZh
              ? "│  ✖ Docker 自動啟動未成功（請確認 Docker Desktop 是否運行中）。\n"
              : "│  ✖ Docker start was not successful (please check if Docker is running).\n",
          );
          stdout.write(
            isZh
              ? "│  您可於稍後手動執行: docker compose up -d\n"
              : "│  You can manually run later: docker compose up -d\n",
          );
        }
      } catch {
        stdout.write(
          isZh
            ? "│  ✖ 未偵測到 Docker 指令，您可於安裝 Docker 後執行: docker compose up -d\n"
            : "│  ✖ Docker command not found. You can run 'docker compose up -d' after installing Docker.\n",
        );
      }
    } else {
      stdout.write(
        isZh
          ? "│  您可於稍後手動啟動容器: docker compose up -d\n"
          : "│  You can manually start the container later: docker compose up -d\n",
      );
    }
  } else {
    stdout.write("│\n");
    stdout.write(
      isZh
        ? "│  ✔ 本機原生模式已設定完成！當 OpenCode 啟動時將自動在背景接管 Broker。\n"
        : "│  ✔ Native mode configured! OpenCode will automatically manage Broker in background.\n",
    );
  }

  // Step 6: Test Notification
  if (!isNode && pairing && api) {
    stdout.write("│\n");
    const sendTest = await reader.ask(
      isZh
        ? "◇  是否發送測試通知到您的 Telegram？ [Y/n]: "
        : "◇  Send a welcome test notification to your Telegram now? [Y/n]: ",
      stdout,
      "Y",
    );
    if (sendTest.toLowerCase() !== "n" && sendTest.toLowerCase() !== "no") {
      try {
        const botDisplayName = botInfo?.username
          ? `@${botInfo.username}`
          : `Bot (ID: ${botInfo?.id})`;
        const welcomeText = isZh
          ? `🎉 <b>OpenCode Telegram Notifier 設定成功！</b>\n\n已成功綁定主機 [${hostLabel}] 與 Telegram。\n當 OpenCode 任務完成、發生異常或需要回覆時，您將在此收到即時通知。\n\n• Bot: ${botDisplayName}\n• 授權用戶 ID: <code>${pairing.userId}</code>`
          : `🎉 <b>OpenCode Telegram Notifier setup complete!</b>\n\nYour host [${hostLabel}] is now linked with Telegram.\nYou will receive notifications here when sessions finish or require input.\n\n• Bot: ${botDisplayName}\n• Authorized User ID: <code>${pairing.userId}</code>`;
        await api.sendMessage({
          chatId: pairing.chatId,
          text: welcomeText,
          parseMode: "HTML",
        });
        stdout.write(
          isZh
            ? "│  ✔ 已成功發送測試通知到您的 Telegram！請檢查手機訊息。\n"
            : "│  ✔ Test notification sent to your Telegram! Please check your messages.\n",
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "send failed";
        stdout.write(
          isZh
            ? `│  ✖ 測試通知發送失敗: ${errMsg}\n`
            : `│  ✖ Failed to send test notification: ${errMsg}\n`,
        );
      }
    }
  }

  stdout.write("│\n");
  stdout.write(
    isZh
      ? "└  🎉 安裝設定完成！您現在可以回到 OpenCode 開始工作。\n\n"
      : "└  🎉 Setup completed! You can now return to OpenCode and start working.\n\n",
  );

  return 0;
}

export async function runSetupCli(
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
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (argv.includes("--help")) {
    stdout.write(setupHelp());
    return 0;
  }

  // Interactive mode when explicitly requested or when run with no arguments & no credential env vars
  const isInteractive =
    argv.includes("-i") ||
    argv.includes("--interactive") ||
    (argv.length === 0 &&
      !env.OPENCODE_TELEGRAM_BOT_TOKEN &&
      !env.OPENCODE_TELEGRAM_BOT_TOKEN_FILE);

  if (isInteractive) {
    return await runInteractiveSetup({
      stdin: options.stdin,
      stdout,
      stderr,
      env,
      fetch: options.fetch,
      cwd: options.cwd,
    });
  }

  try {
    const flags = parseSetupArgs(argv);
    const botToken = await readBotToken(env);
    const pairingNonce = flags.pair ? (flags.nonce ?? createPairingNonce()) : undefined;
    if (pairingNonce) {
      stdout.write(
        `Send this setup code to your Telegram bot from the private chat you want to authorize: ${pairingNonce}\n`,
      );
    }
    const setupOptions: GuidedSetupOptions = {
      botToken,
      locale: flags.locale,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(flags.userId ? { userId: flags.userId } : {}),
      ...(flags.chatId ? { chatId: flags.chatId } : {}),
      ...(flags.stateDirectory ? { stateDirectory: flags.stateDirectory } : {}),
      ...(flags.pair
        ? {
            pairing: {
              enabled: true,
              ...(pairingNonce ? { nonce: pairingNonce } : {}),
              confirm: async (candidate) => await confirmPairing(candidate, options.stdin, stdout),
            },
          }
        : {}),
    };
    const result = await runGuidedSetup(setupOptions);
    if (result.status !== "ready") {
      stderr.write("Setup needs local confirmation before credentials are persisted.\n");
      return 2;
    }
    stdout.write(setupSummary(result));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "setup failed";
    stderr.write(`Setup failed: ${redactTokenLikeText(message)}\n`);
    return 1;
  }
}

export function createPairingNonce(): string {
  return randomBytes(18).toString("base64url");
}

async function waitForPairingMessage(
  api: TelegramBotApi,
  options: { nonce: string; expiresAt: number; now: () => number; pollTimeoutSeconds: number },
): Promise<PairingCandidate> {
  let offset = 0;
  while (options.now() < options.expiresAt) {
    const updates = await api.getUpdates({ offset, timeoutSeconds: options.pollTimeoutSeconds });
    for (const update of updates.sort((left, right) => left.update_id - right.update_id)) {
      offset = Math.max(offset, update.update_id + 1);
      const candidate = pairingCandidate(update, options.nonce);
      if (candidate) return candidate;
    }
  }
  throw new SetupError(
    "PAIRING_EXPIRED",
    "pairing nonce expired before a matching private message arrived",
  );
}

function pairingCandidate(update: TelegramUpdate, nonce: string): PairingCandidate | undefined {
  const message = update.message;
  if (!message?.from || message.from.is_bot) return undefined;
  if (message.chat.type !== "private" || message.sender_chat || message.business_connection_id) {
    return undefined;
  }
  if (message.text?.trim() !== nonce) return undefined;
  if (String(message.chat.id) !== String(message.from.id)) {
    throw new SetupError(
      "PAIRING_CHAT_MISMATCH",
      "pairing requires a private chat owned by the sender",
    );
  }
  return {
    userId: String(message.from.id),
    chatId: String(message.chat.id),
    updateId: update.update_id,
  };
}

async function writePrivateTokenFile(
  stateDirectory: string,
  tokenFile: string,
  token: string,
): Promise<void> {
  await ensurePrivateDirectory(stateDirectory);
  const temporaryPath = join(
    stateDirectory,
    `.telegram-bot-token.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${token}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmodPrivate(temporaryPath, 0o600);
  try {
    await rename(temporaryPath, tokenFile);
    await assertPrivateFile(tokenFile);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new SetupError("SETUP_STATE_UNSAFE", "setup state path must be a regular directory");
  }
  await assertPrivateMode(path, stats.mode, 0o700);
}

async function assertPrivateFile(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new SetupError("SETUP_TOKEN_FILE_UNSAFE", "bot token path must be a regular file");
  }
  await assertPrivateMode(path, stats.mode, 0o600);
}

async function assertPrivateMode(path: string, mode: number, expectedMode: number): Promise<void> {
  if (platform() === "win32") return;
  if ((mode & 0o077) !== 0) {
    throw new SetupError(
      "SETUP_PERMISSIONS_UNSAFE",
      "setup state must not allow group or other access",
    );
  }
  await chmodPrivate(path, expectedMode);
}

async function chmodPrivate(path: string, mode: number): Promise<void> {
  if (platform() !== "win32") await chmod(path, mode);
}

function parseSetupArgs(argv: string[]): {
  locale: SupportedLocale;
  userId?: string;
  chatId?: string;
  stateDirectory?: string;
  pair: boolean;
  nonce?: string;
} {
  const result: {
    locale: SupportedLocale;
    userId?: string;
    chatId?: string;
    stateDirectory?: string;
    pair: boolean;
    nonce?: string;
  } = { locale: "en", pair: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--pair") {
      result.pair = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new SetupError("SETUP_ARGUMENT_MISSING", `${flag} requires a value`);
    index += 1;
    if (flag === "--locale") {
      if (value !== "en" && value !== "zh-TW") {
        throw new SetupError("SETUP_LOCALE_INVALID", "setup locale must be en or zh-TW");
      }
      result.locale = value;
    } else if (flag === "--user-id") {
      result.userId = value;
    } else if (flag === "--chat-id") {
      result.chatId = value;
    } else if (flag === "--state-dir") {
      result.stateDirectory = value;
    } else if (flag === "--nonce") {
      result.nonce = value;
    } else {
      throw new SetupError("SETUP_ARGUMENT_UNKNOWN", `unknown setup option: ${flag}`);
    }
  }
  return result;
}

async function readBotToken(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.OPENCODE_TELEGRAM_BOT_TOKEN_FILE) {
    return (await readFile(env.OPENCODE_TELEGRAM_BOT_TOKEN_FILE, "utf8")).trim();
  }
  if (env.OPENCODE_TELEGRAM_BOT_TOKEN) return env.OPENCODE_TELEGRAM_BOT_TOKEN.trim();
  throw new SetupError(
    "SETUP_CREDENTIAL_MISSING",
    "set OPENCODE_TELEGRAM_BOT_TOKEN_FILE or OPENCODE_TELEGRAM_BOT_TOKEN before running setup",
  );
}

async function confirmPairing(
  candidate: PairingCandidate,
  stdin: AsyncIterable<Buffer | string> | undefined,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<boolean> {
  stdout.write(
    `Pairing request received from Telegram user ${candidate.userId} in private chat ${candidate.chatId}. Type YES to persist this identity: `,
  );
  const answer = await readFirstLine(stdin ?? process.stdin);
  return answer.trim() === "YES";
}

async function readFirstLine(input: AsyncIterable<Buffer | string>): Promise<string> {
  let collected = "";
  for await (const chunk of input) {
    collected += String(chunk);
    const newline = collected.indexOf("\n");
    if (newline >= 0) return collected.slice(0, newline);
  }
  return collected;
}

function setupSummary(result: Extract<GuidedSetupResult, { status: "ready" }>): string {
  const username = result.bot.username ? `@${result.bot.username}` : `bot ${result.bot.id}`;
  return [
    `Telegram ${username} validated.`,
    `Token stored at ${result.tokenFile}.`,
    `Allowed Telegram user/chat: ${result.config.telegram?.userId ?? "N/A"}.`,
    `Locale: ${result.config.locale}.`,
    "Notifier is ready for a test notification.",
    "",
  ].join("\n");
}

function setupHelp(): string {
  return [
    "Usage: opencode-telegram-broker setup [--interactive | -i] [--user-id ID --chat-id ID | --pair] [--locale en|zh-TW] [--state-dir PATH]",
    "",
    "Interactive mode (default when run with no options):",
    "  opencode-telegram-broker setup",
    "",
    "Scripted / Non-interactive options:",
    "  --pair                   Display a short-lived nonce and pair with incoming message.",
    "  --user-id ID             Explicit Telegram user ID.",
    "  --chat-id ID             Explicit Telegram chat ID.",
    "  --locale en|zh-TW        Notification and setup language.",
    "  --state-dir PATH         Custom state directory.",
    "",
    "Read the bot token from OPENCODE_TELEGRAM_BOT_TOKEN_FILE or OPENCODE_TELEGRAM_BOT_TOKEN.",
    "",
  ].join("\n");
}

function sanitizedConfigError(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
}

function redactTokenLikeText(input: string): string {
  return input.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
}

function publicBot(bot: TelegramBot): Pick<TelegramBot, "id" | "username"> {
  return { id: bot.id, ...(bot.username ? { username: bot.username } : {}) };
}
