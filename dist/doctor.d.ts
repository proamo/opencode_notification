export type DoctorCheckStatus = "pass" | "warn" | "fail";
export type DoctorCheck = {
    name: string;
    status: DoctorCheckStatus;
    message: string;
    remediation?: string;
};
export type DoctorReport = {
    ready: boolean;
    checks: DoctorCheck[];
};
export type DoctorOptions = {
    rawConfig?: unknown;
    stateDirectory?: string;
    port?: number;
    bindHost?: string;
    fetch?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
};
export declare function runDoctor(options?: DoctorOptions): Promise<DoctorReport>;
export declare function formatDoctorReport(report: DoctorReport): string;
//# sourceMappingURL=doctor.d.ts.map