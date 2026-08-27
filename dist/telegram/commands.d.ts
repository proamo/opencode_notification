import type { RouteRegistry } from "../broker/registry";
import { type SupportedLocale } from "../i18n";
import type { BrokerCommand, CommandResult } from "../protocol";
export type SlashCommandContext = {
    text: string;
    locale?: SupportedLocale;
    registry: RouteRegistry;
    dispatcher: {
        sendCommand(command: BrokerCommand): Promise<CommandResult>;
    };
    startedAt?: number;
    packageVersion?: string;
};
export declare function isSlashCommand(text?: string): boolean;
export declare function parseSlashCommand(text: string): {
    command: string;
    args: string[];
} | undefined;
export declare function executeSlashCommand(context: SlashCommandContext): Promise<string>;
//# sourceMappingURL=commands.d.ts.map