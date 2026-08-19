import { fetchBrokerStatus, probeBroker, type StartBrokerOptions } from "./broker/server";
import {
  type NotifierConfig,
  NotifierConfigSchema,
  readNotifierBotToken,
  redactSensitiveText,
  sanitizeConfigError,
} from "./config";
import { translate } from "./i18n";
import { loadOrCreateStateIdentity } from "./state";
import { TelegramBotApi } from "./telegram";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  remediation?: string;
};

export type DoctorReport = {
  ready: boolean;
  checks: DoctorCheck[];
};

export type DoctorOptions = {
  rawConfig?: unknown;
  stateDirectory?: string;
  port?: number;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const env = options.env ?? process.env;
  const configResult = parseDoctorConfig(options.rawConfig ?? configFromEnvironment(env));
  checks.push(configResult.check);

  let token: string | undefined;
  if (configResult.config) {
    try {
      token = await readNotifierBotToken(configResult.config);
      checks.push(pass("secret-file", "Credential source is present and access-restricted."));
    } catch (error) {
      checks.push(
        fail(
          "secret-file",
          sanitizeConfigError(error),
          "Fix token-file permissions or rotate the credential.",
        ),
      );
    }
  } else {
    checks.push(
      fail("secret-file", "Credential source could not be checked.", "Fix configuration first."),
    );
  }

  const broker = await checkBroker({
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
    ...(options.port ? { port: options.port } : {}),
  });
  checks.push(...broker.checks);

  if (token) checks.push(await checkTelegram(token, options.fetch));
  else
    checks.push(
      fail("telegram-api", "Telegram credential was unavailable.", "Fix credential configuration."),
    );

  checks.push(checkCatalogs());
  checks.push(checkOpenCodeCompatibility(env));

  return { ready: checks.every((check) => check.status === "pass"), checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`Doctor readiness: ${report.ready ? "ready" : "not ready"}`];
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
    if (check.remediation) lines.push(`Remediation: ${check.remediation}`);
  }
  lines.push("");
  return redactSensitiveText(lines.join("\n"));
}

function parseDoctorConfig(rawConfig: unknown): { check: DoctorCheck; config?: NotifierConfig } {
  const parsed = NotifierConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    return {
      check: fail(
        "configuration",
        sanitizeConfigError(parsed.error),
        "Run setup or fix notifier configuration.",
      ),
    };
  }
  return {
    check: pass("configuration", "Notifier configuration is valid and local-only."),
    config: parsed.data,
  };
}

async function checkBroker(options: StartBrokerOptions): Promise<{ checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const state = await loadOrCreateStateIdentity(options.stateDirectory);
  const port = options.port ?? 42617;
  const health = await probeBroker(port, state.brokerSecret);
  if (!health) {
    if (await isPortOccupiedByNonBroker(port)) {
      checks.push(
        fail(
          "broker-singleton",
          "Configured broker port is occupied by a process that is not the authenticated local broker.",
          "Stop the conflicting process or choose a different local broker port.",
        ),
      );
      checks.push(
        warn(
          "plugin-registration",
          "No authenticated broker is available to inspect plugin registration.",
        ),
      );
      checks.push(warn("loopback-binding", "Broker binding could not be verified."));
      return { checks };
    }
    checks.push(
      warn("broker-reachability", "Broker is stopped or unreachable.", "Start the local broker."),
    );
    checks.push(
      warn(
        "plugin-registration",
        "No broker connection is available to inspect.",
        "Start OpenCode with the plugin enabled.",
      ),
    );
    checks.push(pass("loopback-binding", "V1 control checks use loopback-only endpoints."));
    return { checks };
  }

  checks.push(pass("broker-reachability", `Broker is reachable on 127.0.0.1:${port}.`));
  const status = await fetchBrokerStatus(port, state.brokerSecret);
  if (!status) {
    checks.push(
      warn("plugin-registration", "Broker status endpoint did not return registration details."),
    );
    checks.push(warn("loopback-binding", "Broker binding could not be verified."));
    return { checks };
  }
  if (status.bindHost === "127.0.0.1") {
    checks.push(pass("loopback-binding", "Broker is bound to 127.0.0.1."));
  } else {
    checks.push(
      fail(
        "loopback-binding",
        "Broker is not bound to 127.0.0.1.",
        "Stop it and restart in local mode.",
      ),
    );
  }
  if (status.connections > 0) {
    checks.push(
      pass("plugin-registration", `${status.connections} plugin connection(s) registered.`),
    );
  } else {
    checks.push(
      warn(
        "plugin-registration",
        "No OpenCode plugin connection is currently registered.",
        "Open an OpenCode project with the plugin enabled.",
      ),
    );
  }
  return { checks };
}

async function isPortOccupiedByNonBroker(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      signal: AbortSignal.timeout(500),
    });
    return response.status !== 401;
  } catch {
    return false;
  }
}

async function checkTelegram(
  token: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<DoctorCheck> {
  try {
    const bot = await new TelegramBotApi({ token, fetch: fetchImplementation }).getMe();
    return pass("telegram-api", `Telegram credential is valid for bot ${bot.id}.`);
  } catch (error) {
    return fail(
      "telegram-api",
      sanitizeConfigError(error),
      "Verify network access and rotate the bot credential if needed.",
    );
  }
}

function checkCatalogs(): DoctorCheck {
  try {
    if (!translate("en", "test.message") || !translate("zh-TW", "test.message")) {
      throw new Error("catalog key is empty");
    }
    return pass("catalogs", "English and Traditional Chinese catalogs are available.");
  } catch {
    return fail("catalogs", "A required message catalog is unavailable.", "Reinstall the package.");
  }
}

function checkOpenCodeCompatibility(env: NodeJS.ProcessEnv): DoctorCheck {
  const version = env.OPENCODE_TELEGRAM_OPENCODE_VERSION ?? env.OPENCODE_VERSION;
  if (!version) {
    return warn(
      "opencode-compatibility",
      "OpenCode version could not be established.",
      "Run doctor from an OpenCode environment or set OPENCODE_VERSION.",
    );
  }
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return fail("opencode-compatibility", "OpenCode version format is invalid.");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 1 && minor >= 18)
    return pass("opencode-compatibility", `OpenCode ${version} is supported.`);
  return fail(
    "opencode-compatibility",
    `OpenCode ${version} is outside the supported range.`,
    "Use OpenCode >=1.18.0 <2.",
  );
}

function configFromEnvironment(env: NodeJS.ProcessEnv): unknown {
  const telegram: Record<string, string> = {};
  if (env.OPENCODE_TELEGRAM_BOT_TOKEN) telegram.botToken = env.OPENCODE_TELEGRAM_BOT_TOKEN;
  if (env.OPENCODE_TELEGRAM_BOT_TOKEN_FILE)
    telegram.tokenFile = env.OPENCODE_TELEGRAM_BOT_TOKEN_FILE;
  if (env.OPENCODE_TELEGRAM_USER_ID) telegram.userId = env.OPENCODE_TELEGRAM_USER_ID;
  if (env.OPENCODE_TELEGRAM_CHAT_ID) telegram.chatId = env.OPENCODE_TELEGRAM_CHAT_ID;
  return {
    ...(env.OPENCODE_TELEGRAM_LOCALE ? { locale: env.OPENCODE_TELEGRAM_LOCALE } : {}),
    telegram,
    broker: {
      ...(env.OPENCODE_TELEGRAM_BROKER_PORT
        ? { port: Number(env.OPENCODE_TELEGRAM_BROKER_PORT) }
        : {}),
    },
  };
}

function pass(name: string, message: string): DoctorCheck {
  return { name, status: "pass", message: redactSensitiveText(message) };
}

function warn(name: string, message: string, remediation?: string): DoctorCheck {
  return {
    name,
    status: "warn",
    message: redactSensitiveText(message),
    ...(remediation ? { remediation } : {}),
  };
}

function fail(name: string, message: string, remediation?: string): DoctorCheck {
  return {
    name,
    status: "fail",
    message: redactSensitiveText(message),
    ...(remediation ? { remediation } : {}),
  };
}
