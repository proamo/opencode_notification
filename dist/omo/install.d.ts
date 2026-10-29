export declare function omoAgentDirectory(environment?: NodeJS.ProcessEnv): string;
export declare function omoExtensionDirectory(agentDirectory?: string): string;
export declare function bundledOmoExtensionPath(): string | undefined;
export declare function installOmoExtension(input: {
    agentDirectory?: string;
    bundlePath?: string;
}): Promise<{
    directory: string;
}>;
export declare function removeOmoExtension(agentDirectory?: string): Promise<"removed" | "absent" | "foreign">;
//# sourceMappingURL=install.d.ts.map