export interface SystemdServiceOptions {
    user?: string;
    home?: string;
    execPath?: string;
    binScript?: string;
    envPath?: string;
}
export declare function isSystemdAvailable(): boolean;
export declare function generateSystemdService(options?: SystemdServiceOptions): string;
export declare function installSystemdService(options?: SystemdServiceOptions): Promise<{
    success: boolean;
    error?: string;
}>;
export declare function uninstallSystemdService(): Promise<{
    success: boolean;
    removed: boolean;
    error?: string;
}>;
//# sourceMappingURL=service.d.ts.map