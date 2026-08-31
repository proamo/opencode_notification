import { type NotifierConfig } from "./config";
import type { SupportedLocale } from "./i18n";
import { type TelegramBot } from "./telegram/api";
export declare function resolveDockerComposeContext(cwd?: string, explicitComposePath?: string): {
    composeFile: string;
    projectDir: string;
} | undefined;
export type PairingCandidate = {
    userId: string;
    chatId: string;
    updateId: number;
};
export type GuidedSetupResult = {
    status: "ready";
    bot: Pick<TelegramBot, "id" | "username">;
    config: NotifierConfig;
    tokenFile: string;
    readyForTestNotification: true;
    pairing?: PairingCandidate;
} | {
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
export declare class SetupError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class AsyncPromptReader {
    private input;
    private iterator;
    private buffer;
    constructor(input: AsyncIterable<Buffer | string> | NodeJS.ReadableStream);
    close(): void;
    readLine(): Promise<string>;
    ask(promptText: string, stdout: Pick<NodeJS.WriteStream, "write">, defaultValue?: string): Promise<string>;
}
export declare function runGuidedSetup(options: GuidedSetupOptions): Promise<GuidedSetupResult>;
export declare function runInteractiveSetup(options?: InteractiveSetupOptions): Promise<number>;
export declare function runSetupCli(options?: {
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    stdout?: Pick<NodeJS.WriteStream, "write">;
    stderr?: Pick<NodeJS.WriteStream, "write">;
    stdin?: AsyncIterable<Buffer | string>;
    fetch?: typeof fetch;
    cwd?: string;
}): Promise<number>;
export declare function createPairingNonce(): string;
//# sourceMappingURL=setup.d.ts.map