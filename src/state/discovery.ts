import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PROTOCOL_VERSION } from "../protocol";

export const DiscoveryRecordSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  nonce: z.uuid(),
  protocol: z.object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
  }),
  startedAt: z.iso.datetime({ offset: true }),
});
export type DiscoveryRecord = z.infer<typeof DiscoveryRecordSchema>;

export async function writeDiscoveryRecord(
  stateDirectory: string,
  port: number,
): Promise<DiscoveryRecord> {
  const record: DiscoveryRecord = {
    port,
    pid: process.pid,
    nonce: randomUUID(),
    protocol: PROTOCOL_VERSION,
    startedAt: new Date().toISOString(),
  };
  const destination = discoveryRecordPath(stateDirectory);
  const temporary = `${destination}.${record.nonce}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
  return record;
}

export async function removeDiscoveryRecord(
  stateDirectory: string,
  expectedNonce: string,
): Promise<void> {
  const path = discoveryRecordPath(stateDirectory);
  try {
    const record = DiscoveryRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (record.nonce === expectedNonce) await rm(path, { force: true });
  } catch {
    // The record is informational and never overrides live authenticated discovery.
  }
}

export function discoveryRecordPath(stateDirectory: string): string {
  return join(stateDirectory, "broker.json");
}
