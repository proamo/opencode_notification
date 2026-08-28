import { type NotifierConfig } from "../config";
export type DiscoveredConfigFile = {
    path: string;
    exists: boolean;
    isWorkspace: boolean;
};
export declare function parseJsonc<T = Record<string, unknown>>(content: string): T;
export declare function getCandidateConfigPaths(cwd?: string): string[];
export declare function discoverOpenCodeConfigFiles(cwd?: string): Promise<DiscoveredConfigFile[]>;
export declare function generatePluginConfigSnippet(config: NotifierConfig): string;
export declare function loadResolvedNotifierConfig(explicitOptions?: unknown, cwd?: string): Promise<NotifierConfig | undefined>;
export declare function injectOpenCodeConfig(targetPath: string, config: NotifierConfig): Promise<{
    targetPath: string;
    backupPath?: string;
}>;
export declare function removeOpenCodeConfig(targetPath: string): Promise<{
    modified: boolean;
    backupPath?: string;
}>;
//# sourceMappingURL=config-helper.d.ts.map