import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
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
    }
    expect(Buffer.from(first.brokerSecret, "base64url")).toHaveLength(32);
    expect(Buffer.from(first.routeSalt, "base64url")).toHaveLength(32);
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
