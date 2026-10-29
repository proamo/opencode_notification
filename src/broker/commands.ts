import { existsSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { assertSecureTokenFile, ConfigValidationError, redactSensitiveText } from "../config";
import { formatDoctorReport, runDoctor } from "../doctor";
import { isPrivateGatewayHost } from "../network";
import {
  defaultStateDirectory,
  loadOrCreateStateIdentity,
  rotateGatewaySecret,
  StateDatabase,
} from "../state";
import { TelegramBotApi } from "../telegram";
import {
  BrokerPortConflictError,
  type BrokerServer,
  brokerHttpUrl,
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
  const normalizedArgv = argv[0] === "broker" ? argv.slice(1) : argv;
  const command = normalizedArgv[0];
  const flags = parseFlags(normalizedArgv.slice(1));

  try {
    const brokerOptions = await brokerOptionsFrom(flags, env);
    if (!command || command === "start" || command === "run") {
      return await runStartCommand(brokerOptions, env, streams, options.onStarted);
    }
    if (command === "status") return await runStatusCommand(brokerOptions, streams);
    if (command === "stop") return await runStopCommand(brokerOptions, streams, options.fetch);
    if (command === "purge-state") return await runPurgeStateCommand(brokerOptions, streams);
    if (command === "rotate-credential") {
      return await runRotateCredentialCommand(flags, env, streams);
    }
    if (command === "rotate-gateway-secret") {
      return await runRotateGatewaySecretCommand(flags, env, streams);
    }
    if (command === "test-notification") {
      return await runTestNotificationCommand(flags, env, streams, options.fetch);
    }
    if (command === "doctor") return await runDoctorCommand(flags, env, streams, options.fetch);
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

async function runDoctorCommand(
  flags: Map<string, string | true>,
  env: NodeJS.ProcessEnv,
  streams: CommandStreams,
  fetchImplementation: typeof fetch = fetch,
): Promise<number> {
  const brokerOptions = await brokerOptionsFrom(flags, env);
  const report = await runDoctor({
    env,
    fetch: fetchImplementation,
    ...brokerOptions,
  });
  streams.stdout.write(formatDoctorReport(report));
  return report.checks.some((check) => check.status === "fail") ? 1 : report.ready ? 0 : 2;
}

async function runStartCommand(
  options: StartBrokerOptions,
  env: NodeJS.ProcessEnv,
  streams: CommandStreams,
  onStarted: BrokerCliOptions["onStarted"],
): Promise<number | undefined> {
  try {
    await assertDeploymentOwnsStartEndpoint(options, env);
    const result = await startOrReuseBroker(options);
    if (result.kind === "existing") {
      streams.stdout.write(
        `Broker already running on ${options.bindHost ?? "127.0.0.1"}:${result.port}.\n`,
      );
      return 0;
    }
    streams.stdout.write(
      `Broker started on ${options.bindHost ?? "127.0.0.1"}:${result.broker.port}.\n`,
    );
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

async function assertDeploymentOwnsStartEndpoint(
  options: StartBrokerOptions,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const stateDirectory = options.stateDirectory ?? defaultStateDirectory();
  const ownership = await readDeploymentOwnership(stateDirectory);
  if (!ownership) return;
  if (ownership.mode === "docker" && env.OPENCODE_TELEGRAM_CONTAINER === "1") return;
  if (ownership.mode === "docker" || ownership.mode === "node") {
    throw new ConfigValidationError(
      "DEPLOYMENT_MODE_CONFLICT",
      `${ownership.mode} deployment does not own a host Broker process`,
    );
  }
  const owned = ownership.endpoint ?? (await readPersistedBrokerEndpoint(stateDirectory));
  if (!owned) {
    throw new ConfigValidationError(
      "DEPLOYMENT_ENDPOINT_MISSING",
      "native deployment ownership endpoint is missing; run setup to migrate deployment state",
    );
  }
  const requestedHost = options.bindHost ?? "127.0.0.1";
  const requestedPort = options.port ?? 42617;
  if (owned.bindHost !== requestedHost || owned.port !== requestedPort) {
    throw new ConfigValidationError(
      "DEPLOYMENT_ENDPOINT_CONFLICT",
      `native deployment owns ${owned.bindHost}:${owned.port}; refusing competing Broker endpoint`,
    );
  }
}

type DeploymentOwnership = {
  mode: "native" | "docker" | "node";
  endpoint?: { bindHost: string; port: number };
};

async function readDeploymentOwnership(
  stateDirectory: string,
): Promise<DeploymentOwnership | undefined> {
  const markerPath = join(stateDirectory, "deployment.json");
  let stats: Stats;
  try {
    stats = await lstat(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (process.platform !== "win32" && (stats.mode & 0o077) !== 0) ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  ) {
    throw new ConfigValidationError(
      "DEPLOYMENT_MARKER_UNSAFE",
      "deployment ownership marker is not a private current-user regular file",
    );
  }
  const value = JSON.parse(await readFile(markerPath, "utf8")) as {
    mode?: unknown;
    bindHost?: unknown;
    port?: unknown;
  };
  if (value.mode !== "native" && value.mode !== "docker" && value.mode !== "node") {
    throw new ConfigValidationError(
      "DEPLOYMENT_MODE_INVALID",
      "deployment ownership mode is invalid",
    );
  }
  if (value.mode !== "native") return { mode: value.mode };
  if (value.bindHost === undefined && value.port === undefined) return { mode: "native" };
  const bindHost = typeof value.bindHost === "string" ? parseBindHost(value.bindHost) : undefined;
  if (
    !bindHost ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  ) {
    throw new ConfigValidationError(
      "DEPLOYMENT_ENDPOINT_INVALID",
      "native deployment ownership endpoint is invalid",
    );
  }
  return { mode: "native", endpoint: { bindHost, port: value.port } };
}

async function runStatusCommand(
  options: StartBrokerOptions,
  streams: CommandStreams,
): Promise<number> {
  const state = await loadOrCreateStateIdentity(options.stateDirectory);
  const health = await probeBroker(options.port ?? 42617, state.brokerSecret, options.bindHost);
  if (!health) {
    streams.stdout.write("Broker status: stopped or unreachable.\n");
    return 3;
  }
  streams.stdout.write(
    `Broker status: running on ${options.bindHost ?? "127.0.0.1"}:${options.port ?? 42617}.\n`,
  );
  streams.stdout.write(
    `Machine: ${health.machineId}. Protocol: ${health.protocol.major}.${health.protocol.minor}.\n`,
  );
  return 0;
}

export async function runStopCommand(
  options: StartBrokerOptions,
  streams: CommandStreams,
  fetchImplementation: typeof fetch = fetch,
): Promise<number> {
  const state = await loadOrCreateStateIdentity(options.stateDirectory);
  const port = options.port ?? 42617;
  const health = await probeBroker(port, state.brokerSecret, options.bindHost);
  if (!health) {
    streams.stdout.write("Broker is already stopped or unreachable.\n");
    return 3;
  }
  const response = await fetchImplementation(
    brokerHttpUrl(port, "/v1/control/stop", options.bindHost),
    {
      method: "POST",
      headers: { authorization: `Bearer ${state.brokerSecret}` },
    },
  );
  if (!response.ok) throw new Error("broker rejected the stop command");
  streams.stdout.write("Broker stop requested. OpenCode sessions are not terminated.\n");
  return 0;
}

async function runPurgeStateCommand(
  options: StartBrokerOptions,
  streams: CommandStreams,
): Promise<number> {
  const state = await loadOrCreateStateIdentity(options.stateDirectory);
  if (await probeBroker(options.port ?? 42617, state.brokerSecret, options.bindHost)) {
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

async function runRotateGatewaySecretCommand(
  flags: Map<string, string | true>,
  env: NodeJS.ProcessEnv,
  streams: CommandStreams,
): Promise<number> {
  const stateDirectory = stringFlag(flags, "state-dir") ?? env.OPENCODE_TELEGRAM_BROKER_STATE_DIR;
  const state = await loadOrCreateStateIdentity(stateDirectory);
  await rotateGatewaySecret(state.stateDirectory);
  streams.stdout.write(
    `Gateway credential rotated at ${join(state.stateDirectory, "gateway-secret")}. Update every node and restart the broker.\n`,
  );
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

async function brokerOptionsFrom(
  flags: Map<string, string | true>,
  env: NodeJS.ProcessEnv,
): Promise<StartBrokerOptions> {
  const stateDirectory = stringFlag(flags, "state-dir") ?? env.OPENCODE_TELEGRAM_BROKER_STATE_DIR;
  const explicitPort = parsePositiveInteger(
    stringFlag(flags, "port") ?? env.OPENCODE_TELEGRAM_BROKER_PORT,
  );
  const explicitHost = parseBindHost(
    stringFlag(flags, "bind-host") ?? env.OPENCODE_TELEGRAM_BROKER_BIND_HOST,
  );
  const resolvedStateDirectory = stateDirectory ?? defaultStateDirectory(env);
  const ownership =
    explicitHost && explicitPort
      ? undefined
      : await readDeploymentOwnership(resolvedStateDirectory);
  const ownedEndpoint = ownership?.mode === "native" ? ownership.endpoint : undefined;
  const preferredHost = explicitHost ?? ownedEndpoint?.bindHost;
  const preferredPort = explicitPort ?? ownedEndpoint?.port;
  const persisted =
    preferredHost && preferredPort
      ? undefined
      : await readPersistedBrokerEndpoint(resolvedStateDirectory, {
          ...(preferredHost ? { bindHost: preferredHost } : {}),
          ...(preferredPort ? { port: preferredPort } : {}),
        });
  const port = explicitPort ?? ownedEndpoint?.port ?? persisted?.port;
  const bindHost = explicitHost ?? ownedEndpoint?.bindHost ?? persisted?.bindHost;
  const idleTimeoutMs = parsePositiveInteger(env.OPENCODE_TELEGRAM_BROKER_IDLE_TIMEOUT_MS);
  return {
    ...(stateDirectory ? { stateDirectory } : {}),
    ...(bindHost ? { bindHost } : {}),
    ...(port ? { port } : {}),
    ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
  };
}

function parseBindHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (isIP(value) === 0) {
    throw new ConfigValidationError(
      "BIND_HOST_INVALID",
      "bind host must be a valid IPv4 or IPv6 address",
    );
  }
  if (value === "0.0.0.0" || value === "::" || isPrivateGatewayHost(value)) return value;
  throw new ConfigValidationError(
    "BIND_HOST_INSECURE",
    "public bind hosts require a TLS reverse proxy and cannot receive plaintext lifecycle credentials",
  );
}

export async function readPersistedBrokerEndpoint(
  stateDirectory: string,
  overrides: { bindHost?: string; port?: number } = {},
): Promise<{ bindHost: string; port: number } | undefined> {
  const path = join(stateDirectory, "opencode-notifier.json");
  if (!existsSync(path)) return undefined;
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ConfigValidationError(
      "PERSISTED_CONFIG_UNSAFE",
      "persisted Gateway configuration must be a regular file",
    );
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new ConfigValidationError(
      "PERSISTED_CONFIG_PERMISSIONS_UNSAFE",
      "persisted Gateway configuration must not allow group or other access",
    );
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new ConfigValidationError(
      "PERSISTED_CONFIG_OWNER_UNSAFE",
      "persisted Gateway configuration must be owned by the current user",
    );
  }
  const value = JSON.parse(await readFile(path, "utf8")) as {
    broker?: { host?: unknown; port?: unknown };
  };
  const bindHost =
    overrides.bindHost ??
    parseBindHost(typeof value.broker?.host === "string" ? value.broker.host : undefined);
  const port = overrides.port ?? value.broker?.port;
  if (
    !bindHost ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new ConfigValidationError(
      "PERSISTED_ENDPOINT_INVALID",
      "persisted Gateway host or port is missing or invalid",
    );
  }
  return { bindHost, port };
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
  const directory = dirname(path);
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
    "Usage: opencode-telegram-broker [start|status|stop|doctor|test-notification|purge-state|rotate-credential|rotate-gateway-secret] [options]",
    "",
    "Common options: --state-dir PATH --port PORT --bind-host IP",
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
