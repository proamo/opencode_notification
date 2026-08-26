import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { platform } from "node:os";
import { z } from "zod";

const TelegramIdSchema = z.string().regex(/^[1-9]\d*$/, "must be a positive Telegram numeric ID");
const TelegramBotTokenSchema = z
  .string()
  .regex(/^\d+:[A-Za-z0-9_-]{20,}$/, "Telegram bot token format is invalid");
const LoopbackHostSchema = z.enum(["127.0.0.1", "localhost", "::1"]);
export const ConfigFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const LocalePreferenceSchema = z.enum(["auto", "en", "zh-TW"]);
export type LocalePreference = z.infer<typeof LocalePreferenceSchema>;

export const NotifierConfigSchema = z
  .object({
    mode: z.literal("local").default("local"),
    role: z.enum(["gateway", "node"]).default("gateway"),
    hostLabel: z.string().min(1).max(128).optional(),
    locale: LocalePreferenceSchema.default("auto"),
    gateway: z
      .object({
        url: z.string().min(1),
        secret: z.string().min(1),
      })
      .optional(),
    telegram: z
      .object({
        botToken: TelegramBotTokenSchema.optional(),
        tokenFile: z.string().min(1).optional(),
        userId: TelegramIdSchema,
        chatId: TelegramIdSchema,
      })
      .strict()
      .optional(),
    notifications: z
      .object({
        completion: z.boolean().default(true),
        error: z.boolean().default(true),
        question: z.boolean().default(true),
        permission: z.boolean().default(true),
        includeChildLifecycle: z.boolean().default(false),
        completionDebounceMs: z.number().int().min(0).max(60_000).default(1_500),
        pluginBufferSize: z.number().int().min(1).max(1_000).default(100),
      })
      .strict()
      .prefault({}),
    broker: z
      .object({
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(1024).max(65535).default(42617),
      })
      .strict()
      .prefault({}),
    interaction: z
      .object({
        sessionPromptTtlMinutes: z
          .number()
          .int()
          .min(1)
          .max(24 * 60)
          .default(24 * 60),
        questionTtlMinutes: z
          .number()
          .int()
          .min(1)
          .max(24 * 60)
          .default(30),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine(({ role, gateway, telegram }, context) => {
    if (role === "node") {
      if (!gateway) {
        context.addIssue({
          code: "custom",
          message: "node role requires gateway configuration (url and secret)",
          path: ["gateway"],
        });
      }
      return;
    }

    if (!telegram) {
      context.addIssue({
        code: "custom",
        message: "gateway role requires telegram configuration",
        path: ["telegram"],
      });
      return;
    }

    if (Boolean(telegram.botToken) === Boolean(telegram.tokenFile)) {
      context.addIssue({
        code: "custom",
        message: "configure exactly one of botToken or tokenFile",
        path: ["telegram"],
      });
    }

    if (telegram.chatId !== telegram.userId) {
      context.addIssue({
        code: "custom",
        message: "requires a private Telegram chat owned by the allowed user",
        path: ["telegram", "chatId"],
      });
    }
  });

export type NotifierConfig = z.infer<typeof NotifierConfigSchema>;
export type ConfigFingerprint = z.infer<typeof ConfigFingerprintSchema>;

export class ConfigValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(redactSensitiveText(message));
    this.name = "ConfigValidationError";
    this.code = code;
  }
}

export async function readNotifierBotToken(config: NotifierConfig): Promise<string> {
  if (!config.telegram) {
    throw new ConfigValidationError("TELEGRAM_CONFIG_MISSING", "Telegram configuration is missing");
  }
  if (config.telegram.botToken) return TelegramBotTokenSchema.parse(config.telegram.botToken);
  const tokenFile = config.telegram.tokenFile;
  if (!tokenFile) {
    throw new ConfigValidationError("TOKEN_MISSING", "Telegram bot token source is missing");
  }
  await assertSecureTokenFile(tokenFile);
  const token = (await readFile(tokenFile, "utf8")).trim();
  const parsed = TelegramBotTokenSchema.safeParse(token);
  if (!parsed.success) {
    throw new ConfigValidationError("TOKEN_INVALID", "Telegram bot token file is invalid");
  }
  return parsed.data;
}

export async function assertSecureTokenFile(path: string): Promise<void> {
  const stats = await lstat(path).catch(() => {
    throw new ConfigValidationError("TOKEN_FILE_MISSING", "Telegram bot token file is missing");
  });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ConfigValidationError(
      "TOKEN_FILE_UNSAFE",
      "Telegram bot token file must be a regular file",
    );
  }
  if (platform() !== "win32") {
    if ((stats.mode & 0o077) !== 0) {
      throw new ConfigValidationError(
        "TOKEN_FILE_PERMISSIONS_UNSAFE",
        "Telegram bot token file must not allow group or other access",
      );
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new ConfigValidationError(
        "TOKEN_FILE_OWNER_UNSAFE",
        "Telegram bot token file must be owned by the current user",
      );
    }
  }
}

export function computeNotifierConfigFingerprint(config: NotifierConfig): ConfigFingerprint {
  const fingerprintInput = {
    mode: config.mode,
    role: config.role,
    hostLabel: config.hostLabel,
    locale: config.locale,
    gateway: config.gateway,
    telegram: config.telegram
      ? {
          userId: config.telegram.userId,
          chatId: config.telegram.chatId,
          credentialSource: config.telegram.botToken ? "inline" : "file",
        }
      : undefined,
    notifications: config.notifications,
    broker: config.broker,
    interaction: config.interaction,
  };
  return createHash("sha256").update(stableJson(fingerprintInput)).digest("hex");
}

export function sanitizeConfigError(error: unknown): string {
  if (error instanceof ConfigValidationError) return error.message;
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
  }
  if (error instanceof Error) return redactSensitiveText(error.message);
  return "configuration is invalid";
}

export function redactSensitiveText(input: string): string {
  return input.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
