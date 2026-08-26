import { type BrokerServer, type StartBrokerOptions } from "./server";
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
export declare function runBrokerCli(options?: BrokerCliOptions): Promise<number | undefined>;
export declare function runStopCommand(options: StartBrokerOptions, streams: CommandStreams, fetchImplementation?: typeof fetch): Promise<number>;
export {};
//# sourceMappingURL=commands.d.ts.map