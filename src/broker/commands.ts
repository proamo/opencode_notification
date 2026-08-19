import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertSecureTokenFile, ConfigValidationError, redactSensitiveText } from "../config";
import { loadOrCreateStateIdentity, StateDatabase } from "../state";
import { TelegramBotApi } from "../telegram";
import {
  BrokerPortConflictError,
  type BrokerServer,
  probeBroker,
  type StartBrokerOptions,
  startOrReuseBroker,
} from "./server";

type CommandStreams = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

export type BrokerCliOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  fetch?: typeof fetch;
  onStarted?: (broker: BrokerServer) => void | Promise<void>;
};

export async function runBrokerCli(options: BrokerCliOptions = {}): Promise<number | undefined> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const streams = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
  const command = argv[0];
  const flags = parseFlags(argv.slice(1));
  const brokerOptions = brokerOptionsFrom(flags, env);

  if (!command || command === "start") {
    return await runStartCommand(brokerOptions, streams, options.onStarted);
  }

  try {
    if (command === "status") return await runStatusCommand(brokerOptions, streams);
    if (command === "stop") return await runStopCommand(brokerOptions, streams, options.fetch);
    if (command === "purge-state") return await runPurgeStateCommand(brokerOptions, streams);
    if (command === "rotate-credential") {
      return await runRotateCredentialCommand(flags, env, streams);
    }
    if (command === "test-notification") {
      return await runTestNotificationCommand(flags, env, streams, options.fetch);
    }
    if (command === "--help" || command === "help") {
      streams.stdout.write(commandHelp());
      return 0;
    }
    streams.stderr.write(`Unknown broker command: ${command}\n`);
    streams.stderr.write(commandHelp());
    return 2;
  } catch (error) {
    streams.stderr.write(`Command failed: ${sanitizeError(error)}\n`);
    return 1;
  }
}

async function runStartCommand(
  options: StartBrokerOptions,
  streams: CommandStreams,
  onStarted: BrokerCliOptions["onStarted"],
): Promise<number | undefined> {
  try {
    const result = await startOrReuseBroker(options);
    if (result.kind === "existing") {
      streams.stdout.write(`Broker already running on 127.0.0.1:${result.port}.\n`);
      return 0;
    }
    streams.stdout.write(`Broker started on 127.0.0.1:${result.broker.port}.\n`);
    await onStarted?.(result.broker);
    const stop = () => void result.broker.stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await result.broker.finished;
    return undefined;
  } catch (error) {
    streams.stderr.write(`Broker start failed: ${sanitizeError(error)}\n`);
    return 1;
  }
}

async function runStatusCommand(
  options: StartBrokerOptions,
  streams: CommandStreams,
): Promise<number> {
  const state = await loadOrCreateStateIdentity(options.stateDirectory);
  const health = await probeBroker(options.port ?? 42617, state.brokerSecret);
  if (!health) {
    streams.stdout.write("Broker status: stopped or unreachable.\n");
    return 3;
  }
  streams.stdout.write(`Broker status: running on 127.0.0.1:${options.port ?? 42617}.\n`);
  streams.stdout.write(
    `Machine: ${health.machineId}. Protocol: ${health.protocol.major}.${health.protocol.minor}.\n`,
  );
  return 0;
}

async function runStopCommand(
  options: StartBrokerOptions,
  streams: CommandStreams,
  fetchImplementation: typeof fetch = fetch,
): Promise<number> {
  const state = await loadOrCreateStateIdentity(options.stateDirectory);
  const port = options.port ?? 42617;
  const health = await probeBroker(port, state.brokerSecret);
  if (!health) {
    streams.stdout.write("Broker is already stopped or unreachable.\n");
    return 3;
  }
  const response = await fetchImplementation(`http://127.0.0.1:${port}/v1/control/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.brokerSecret}` },
  });
  if (!response.ok) throw new Error("broker rejected the stop command");
  streams.stdout.write("Broker stop requested. OpenCode sessions are not terminated.\n");
  return 0;
}

async function runPurgeStateCommand(
  options: StartBrokerOptions,
  streams: CommandStreams,
): Promise<number> {
  const state = await loadOrCreateStateIdentity(options.stateDirectory);
  if (await probeBroker(options.port ?? 42617, state.brokerSecret)) {
    streams.stderr.write("Stop the broker before purging state.\n");
    return 1;
  }
  const database = await StateDatabase.open({
    stateDirectory: state.stateDirectory,
    machineId: state.machineId,
  });
  try {
    const before = database.purgeOperationalState();
    database.vacuum();
    streams.stdout.write(
      `Purged operational state: ${before.inboundUpdates} inbound updates, ${before.dedupeRecords} dedupe records.\n`,
    );
    return 0;
  } finally {
    database.close();
  }
}

async function runRotateCredentialCommand(
  flags: Map<string, string | true>,
  env: NodeJS.ProcessEnv,
  streams: CommandStreams,
): Promise<number> {
  const stateDirectory = stringFlag(flags, "state-dir") ?? env.OPENCODE_TELEGRAM_BROKER_STATE_DIR;
  const state = await loadOrCreateStateIdentity(stateDirectory);
  const tokenFile =
    stringFlag(flags, "token-file") ?? join(state.stateDirectory, "telegram-bot-token");
  const token = await readSecretToken(env);
  await writePrivateTokenFile(tokenFile, token);
  streams.stdout.write(`Credential rotated at ${tokenFile}. Restart the broker to use it.\n`);
  return 0;
}

async function runTestNotificationCommand(
  flags: Map<string, string | true>,
  env: NodeJS.ProcessEnv,
  streams: CommandStreams,
  fetchImplementation: typeof fetch = fetch,
): Promise<number> {
  const token = await readSecretToken(env);
  const chatId = stringFlag(flags, "chat-id") ?? env.OPENCODE_TELEGRAM_CHAT_ID;
  if (!chatId || !/^[1-9]\d*$/.test(chatId)) {
    throw new ConfigValidationError("TEST_CHAT_MISSING", "test notification requires --chat-id");
  }
  const locale = stringFlag(flags, "locale") === "zh-TW" ? "zh-TW" : "en";
  const text =
    locale === "zh-TW"
      ? "OpenCode Telegram Link 測試通知。此訊息不包含 session 內容，也不會建立可路由互動。"
      : "OpenCode Telegram Link test notification. This message contains no session content and creates no routable interaction.";
  const api = new TelegramBotApi({ token, fetch: fetchImplementation });
  await api.getMe();
  await api.sendMessage({ chatId, text, disableNotification: true });
  streams.stdout.write("Test notification sent.\n");
  return 0;
}

function brokerOptionsFrom(
  flags: Map<string, string | true>,
  env: NodeJS.ProcessEnv,
): StartBrokerOptions {
  const stateDirectory = stringFlag(flags, "state-dir") ?? env.OPENCODE_TELEGRAM_BROKER_STATE_DIR;
  const port = parsePositiveInteger(stringFlag(flags, "port") ?? env.OPENCODE_TELEGRAM_BROKER_PORT);
  const idleTimeoutMs = parsePositiveInteger(env.OPENCODE_TELEGRAM_BROKER_IDLE_TIMEOUT_MS);
  return {
    ...(stateDirectory ? { stateDirectory } : {}),
    ...(port ? { port } : {}),
    ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
  };
}

async function readSecretToken(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.OPENCODE_TELEGRAM_BOT_TOKEN_FILE) {
    await assertSecureTokenFile(env.OPENCODE_TELEGRAM_BOT_TOKEN_FILE);
    return (await readFile(env.OPENCODE_TELEGRAM_BOT_TOKEN_FILE, "utf8")).trim();
  }
  if (env.OPENCODE_TELEGRAM_BOT_TOKEN) return env.OPENCODE_TELEGRAM_BOT_TOKEN.trim();
  throw new ConfigValidationError(
    "TOKEN_MISSING",
    "set OPENCODE_TELEGRAM_BOT_TOKEN_FILE or OPENCODE_TELEGRAM_BOT_TOKEN",
  );
}

async function writePrivateTokenFile(path: string, token: string): Promise<void> {
  const directory = path.slice(0, path.lastIndexOf("/")) || ".";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${token}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, 0o600);
  try {
    await rename(temporaryPath, path);
    await assertSecureTokenFile(path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function parseFlags(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw?.startsWith("--")) continue;
    const key = raw.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      index += 1;
    }
  }
  return flags;
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function commandHelp(): string {
  return [
    "Usage: opencode-telegram-broker [start|status|stop|test-notification|purge-state|rotate-credential] [options]",
    "",
    "Common options: --state-dir PATH --port PORT",
    "test-notification options: --chat-id ID --locale en|zh-TW",
    "rotate-credential options: --token-file PATH",
    "Secrets are read from OPENCODE_TELEGRAM_BOT_TOKEN_FILE or OPENCODE_TELEGRAM_BOT_TOKEN.",
    "",
  ].join("\n");
}

function sanitizeError(error: unknown): string {
  if (error instanceof BrokerPortConflictError) return error.message;
  if (error instanceof Error) return redactSensitiveText(error.message);
  return "operation failed";
}
