import type { PluginInput } from "@opencode-ai/plugin";
import type { BrokerCommand, CommandResult } from "../protocol";
export declare function runOpenCodeCommand(client: PluginInput["client"], directory: string, command: BrokerCommand): Promise<CommandResult>;
//# sourceMappingURL=commands.d.ts.map