import { z } from "zod";
export declare const ConfigFingerprintSchema: z.ZodString;
export declare const LocalePreferenceSchema: z.ZodEnum<{
    auto: "auto";
    en: "en";
    "zh-TW": "zh-TW";
}>;
export type LocalePreference = z.infer<typeof LocalePreferenceSchema>;
export declare const NotifierConfigSchema: z.ZodObject<{
    mode: z.ZodDefault<z.ZodLiteral<"local">>;
    role: z.ZodDefault<z.ZodEnum<{
        gateway: "gateway";
        node: "node";
    }>>;
    hostLabel: z.ZodOptional<z.ZodString>;
    locale: z.ZodDefault<z.ZodEnum<{
        auto: "auto";
        en: "en";
        "zh-TW": "zh-TW";
    }>>;
    gateway: z.ZodOptional<z.ZodObject<{
        url: z.ZodString;
        secret: z.ZodString;
    }, z.core.$strip>>;
    telegram: z.ZodOptional<z.ZodObject<{
        botToken: z.ZodOptional<z.ZodString>;
        tokenFile: z.ZodOptional<z.ZodString>;
        userId: z.ZodString;
        chatId: z.ZodString;
    }, z.core.$strict>>;
    notifications: z.ZodPrefault<z.ZodObject<{
        completion: z.ZodDefault<z.ZodBoolean>;
        error: z.ZodDefault<z.ZodBoolean>;
        question: z.ZodDefault<z.ZodBoolean>;
        permission: z.ZodDefault<z.ZodBoolean>;
        includeChildLifecycle: z.ZodDefault<z.ZodBoolean>;
        completionDebounceMs: z.ZodDefault<z.ZodNumber>;
        pluginBufferSize: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    broker: z.ZodPrefault<z.ZodObject<{
        host: z.ZodDefault<z.ZodString>;
        port: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    interaction: z.ZodPrefault<z.ZodObject<{
        sessionPromptTtlMinutes: z.ZodDefault<z.ZodNumber>;
        questionTtlMinutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    voice: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        provider: z.ZodDefault<z.ZodEnum<{
            groq: "groq";
            openai: "openai";
            cloudflare: "cloudflare";
            custom: "custom";
        }>>;
        apiKey: z.ZodOptional<z.ZodString>;
        apiKeyFile: z.ZodOptional<z.ZodString>;
        accountId: z.ZodOptional<z.ZodString>;
        model: z.ZodDefault<z.ZodString>;
        endpoint: z.ZodOptional<z.ZodString>;
        language: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type NotifierConfig = z.infer<typeof NotifierConfigSchema>;
export type ConfigFingerprint = z.infer<typeof ConfigFingerprintSchema>;
export declare class ConfigValidationError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function readNotifierBotToken(config: NotifierConfig): Promise<string>;
export declare function readVoiceApiKey(config: NotifierConfig): Promise<string | undefined>;
export declare function assertSecureTokenFile(path: string): Promise<void>;
export declare function computeNotifierConfigFingerprint(config: NotifierConfig): ConfigFingerprint;
export declare function sanitizeConfigError(error: unknown): string;
export declare function redactSensitiveText(input: string): string;
//# sourceMappingURL=config.d.ts.map