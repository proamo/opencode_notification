import { z } from "zod";

const TelegramIdSchema = z.string().regex(/^[1-9]\d*$/, "must be a positive Telegram numeric ID");

export const LocalePreferenceSchema = z.enum(["auto", "en", "zh-TW"]);
export type LocalePreference = z.infer<typeof LocalePreferenceSchema>;

export const NotifierConfigSchema = z
  .object({
    mode: z.literal("local").default("local"),
    locale: LocalePreferenceSchema.default("auto"),
    telegram: z.object({
      botToken: z.string().min(20).optional(),
      tokenFile: z.string().min(1).optional(),
      userId: TelegramIdSchema,
      chatId: TelegramIdSchema,
    }),
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
      .prefault({}),
    broker: z
      .object({
        port: z.number().int().min(1024).max(65535).default(42617),
      })
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
      .prefault({}),
  })
  .superRefine(({ telegram }, context) => {
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
        message: "V1 requires a private Telegram chat owned by the allowed user",
        path: ["telegram", "chatId"],
      });
    }
  });

export type NotifierConfig = z.infer<typeof NotifierConfigSchema>;
