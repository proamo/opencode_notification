import type { RouteKey } from "../protocol";
export type StateIdentity = {
    stateDirectory: string;
    machineId: string;
    brokerSecret: string;
    routeSalt: string;
};
export declare function defaultStateDirectory(environment?: NodeJS.ProcessEnv): string;
export declare function loadOrCreateStateIdentity(stateDirectory?: string): Promise<StateIdentity>;
export declare function createInstanceId(): string;
export declare function createRouteGeneration(): string;
export declare function deriveProjectId(projectPath: string, routeSalt: string): Promise<string>;
export declare function createRouteKey(input: {
    machineId: string;
    instanceId: string;
    projectId: string;
    sessionId: string;
}): RouteKey;
//# sourceMappingURL=identity.d.ts.map