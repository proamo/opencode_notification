import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { type NotifierConfig, NotifierConfigSchema } from "./config";
import type { SupportedLocale } from "./i18n";
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

export class SetupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SetupError";
    this.code = code;
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

export async function runSetupCli(
  options: {
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    stdout?: Pick<NodeJS.WriteStream, "write">;
    stderr?: Pick<NodeJS.WriteStream, "write">;
    stdin?: AsyncIterable<Buffer | string>;
    fetch?: typeof fetch;
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
    `Allowed Telegram user/chat: ${result.config.telegram.userId}.`,
    `Locale: ${result.config.locale}.`,
    "Notifier is ready for a test notification.",
    "",
  ].join("\n");
}

function setupHelp(): string {
  return [
    "Usage: opencode-telegram-broker setup [--user-id ID --chat-id ID | --pair] [--locale en|zh-TW] [--state-dir PATH]",
    "",
    "Read the bot token from OPENCODE_TELEGRAM_BOT_TOKEN_FILE or OPENCODE_TELEGRAM_BOT_TOKEN.",
    "Use --pair to display a short-lived nonce and confirm the discovered private chat locally.",
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
