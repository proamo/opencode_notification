import { z } from "zod";
export declare const DiscoveryRecordSchema: z.ZodObject<{
    port: z.ZodNumber;
    pid: z.ZodNumber;
    nonce: z.ZodUUID;
    protocol: z.ZodObject<{
        major: z.ZodNumber;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    startedAt: z.ZodISODateTime;
}, z.core.$strip>;
export type DiscoveryRecord = z.infer<typeof DiscoveryRecordSchema>;
export declare function writeDiscoveryRecord(stateDirectory: string, port: number): Promise<DiscoveryRecord>;
export declare function removeDiscoveryRecord(stateDirectory: string, expectedNonce: string): Promise<void>;
export declare function discoveryRecordPath(stateDirectory: string): string;
//# sourceMappingURL=discovery.d.ts.map