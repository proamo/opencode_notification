export declare const DASHBOARD_SESSION_COOKIE = "opencode_session";
export declare function dashboardPasswordPath(stateDirectory: string): string;
export declare function readDashboardPasswordHash(stateDirectory: string): Promise<string | undefined>;
export declare function setDashboardPassword(stateDirectory: string, password: string): Promise<void>;
export declare function verifyDashboardPassword(hash: string, password: string): Promise<boolean>;
export declare function issueDashboardSession(brokerSecret: string, passwordHash: string, now?: number): string;
export declare function verifyDashboardSession(value: string, brokerSecret: string, passwordHash: string, now?: number): boolean;
export declare function dashboardSessionCookie(value: string, maxAgeSeconds?: number): string;
export declare class LoginRateLimiter {
    #private;
    private readonly limit;
    private readonly windowMs;
    constructor(limit?: number, windowMs?: number);
    blocked(key: string, now?: number): boolean;
    fail(key: string, now?: number): void;
    reset(key: string): void;
}
//# sourceMappingURL=dashboard-auth.d.ts.map