export interface SystemdServiceOptions {
    user?: string | undefined;
    home?: string | undefined;
    execPath?: string | undefined;
    binScript?: string | undefined;
    envPath?: string | undefined;
    bindHost?: string | undefined;
    stateDirectory?: string | undefined;
    xdgStateHome?: string | undefined;
    xdgConfigHome?: string | undefined;
    serviceFile?: string | undefined;
    spawnSync?: ((command: string[]) => {
        exitCode: number;
        stderr?: Uint8Array;
    }) | undefined;
}
export declare function isSystemdAvailable(): boolean;
export declare function generateSystemdService(options?: SystemdServiceOptions): string;
export declare function installSystemdService(options?: SystemdServiceOptions): Promise<{
    success: boolean;
    error?: string;
}>;
export declare function uninstallSystemdService(options?: SystemdServiceOptions): Promise<{
    success: boolean;
    removed: boolean;
    error?: string;
}>;
//# sourceMappingURL=service.d.ts.map