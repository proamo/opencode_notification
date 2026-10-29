import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInstanceId,
  createRouteKey,
  deriveProjectId,
  loadOrCreateStateIdentity,
} from "../src/state";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("state identity", () => {
  test("creates stable private machine state", async () => {
    const directory = await createTemporaryDirectory();
    const first = await loadOrCreateStateIdentity(directory);
    const second = await loadOrCreateStateIdentity(directory);

    expect(second).toEqual(first);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "broker-secret"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "gateway-secret"))).mode & 0o777).toBe(0o600);
    }
    expect(Buffer.from(first.brokerSecret, "base64url")).toHaveLength(32);
    expect(Buffer.from(first.gatewaySecret, "base64url")).toHaveLength(32);
    expect(first.gatewaySecret).not.toBe(first.brokerSecret);
    expect(Buffer.from(first.routeSalt, "base64url")).toHaveLength(32);
  });

  test("migrates an existing broker secret without disconnecting RC.8 nodes", async () => {
    const directory = await createTemporaryDirectory();
    const legacySecret = randomBytes(32).toString("base64url");
    await writeFile(join(directory, "broker-secret"), `${legacySecret}\n`, { mode: 0o600 });

    const identity = await loadOrCreateStateIdentity(directory);

    expect(identity.brokerSecret).toBe(legacySecret);
    expect(identity.gatewaySecret).toBe(legacySecret);
  });

  test("keeps fresh Node and administrator credentials separate during concurrent startup", async () => {
    const directory = await createTemporaryDirectory();

    const identities = await Promise.all(
      Array.from({ length: 20 }, () => loadOrCreateStateIdentity(directory)),
    );

    expect(new Set(identities.map((identity) => identity.brokerSecret)).size).toBe(1);
    expect(new Set(identities.map((identity) => identity.gatewaySecret)).size).toBe(1);
    expect(identities[0]?.gatewaySecret).not.toBe(identities[0]?.brokerSecret);
  });

  test.skipIf(process.platform === "win32")("rejects state exposed to other users", async () => {
    const parent = await createTemporaryDirectory();
    const directory = join(parent, "unsafe-state");
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);

    await expect(loadOrCreateStateIdentity(directory)).rejects.toThrow("group or other access");
  });

  test("derives stable opaque project identities from canonical paths", async () => {
    const directory = await createTemporaryDirectory();
    const state = await loadOrCreateStateIdentity(join(directory, "state"));
    const project = join(directory, "project");
    await mkdir(project);

    const first = await deriveProjectId(project, state.routeSalt);
    const second = await deriveProjectId(project, state.routeSalt);

    expect(first).toBe(second);
    expect(first).not.toContain(project);
    expect(first).toHaveLength(43);
  });

  test("creates process and generation-specific route keys", () => {
    const machineId = crypto.randomUUID();
    const firstInstance = createInstanceId();
    const secondInstance = createInstanceId();
    const base = { machineId, projectId: "opaque-project-id", sessionId: "ses_123" };

    const first = createRouteKey({ ...base, instanceId: firstInstance });
    const nextGeneration = createRouteKey({ ...base, instanceId: firstInstance });
    const otherProcess = createRouteKey({ ...base, instanceId: secondInstance });

    expect(first.routeGeneration).not.toBe(nextGeneration.routeGeneration);
    expect(first.instanceId).not.toBe(otherProcess.instanceId);
  });

  test("allows state initialization in container mode (OPENCODE_TELEGRAM_CONTAINER=1)", async () => {
    const original = process.env.OPENCODE_TELEGRAM_CONTAINER;
    process.env.OPENCODE_TELEGRAM_CONTAINER = "1";
    try {
      const directory = await createTemporaryDirectory();
      const state = await loadOrCreateStateIdentity(directory);
      expect(state).toBeDefined();
      expect(state.machineId).toBeDefined();
    } finally {
      if (original !== undefined) {
        process.env.OPENCODE_TELEGRAM_CONTAINER = original;
      } else {
        delete process.env.OPENCODE_TELEGRAM_CONTAINER;
      }
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-telegram-link-"));
  temporaryDirectories.push(directory);
  return directory;
}
