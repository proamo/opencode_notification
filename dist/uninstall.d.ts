import { type InteractiveSetupOptions } from "./setup";
export declare function runInteractiveUninstall(options?: InteractiveSetupOptions): Promise<number>;
export declare function runUninstallCli(options?: {
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    stdout?: Pick<NodeJS.WriteStream, "write">;
    stderr?: Pick<NodeJS.WriteStream, "write">;
    stdin?: AsyncIterable<Buffer | string>;
    fetch?: typeof fetch;
    cwd?: string;
}): Promise<number>;
//# sourceMappingURL=uninstall.d.ts.map