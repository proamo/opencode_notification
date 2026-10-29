import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RouteKey } from "../protocol";

const UUIDSchema = z.uuid();
const SECRET_BYTES = 32;
const IDENTITY_MODE_LEGACY = "2:legacy";
const IDENTITY_MODE_SEPARATE = "2:separate";

export type StateIdentity = {
  stateDirectory: string;
  machineId: string;
  brokerSecret: string;
  gatewaySecret: string;
  routeSalt: string;
};

export function defaultStateDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.XDG_STATE_HOME) {
    return join(environment.XDG_STATE_HOME, "opencode-telegram-link");
  }

  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "opencode-telegram-link");
  }

  if (platform() === "win32" && environment.LOCALAPPDATA) {
    return join(environment.LOCALAPPDATA, "opencode-telegram-link");
  }

  return join(homedir(), ".local", "state", "opencode-telegram-link");
}

export async function loadOrCreateStateIdentity(
  stateDirectory = defaultStateDirectory(),
): Promise<StateIdentity> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await assertPrivatePath(stateDirectory, "directory", 0o700);

  const machineId = await loadOrCreatePrivateValue(
    join(stateDirectory, "machine-id"),
    () => randomUUID(),
    (value) => UUIDSchema.parse(value),
  );
  const brokerSecretPath = join(stateDirectory, "broker-secret");
  const versionPath = join(stateDirectory, "identity-version");
  const identityMode = await loadOrCreatePrivateValue(
    versionPath,
    () => (existsSync(brokerSecretPath) ? IDENTITY_MODE_LEGACY : IDENTITY_MODE_SEPARATE),
    (value) => {
      if (value === "2") return IDENTITY_MODE_SEPARATE;
      if (value !== IDENTITY_MODE_LEGACY && value !== IDENTITY_MODE_SEPARATE) {
        throw new Error("unsupported state identity version");
      }
      return value;
    },
  );
  const legacyIdentity = identityMode === IDENTITY_MODE_LEGACY;
  const brokerSecret = await loadOrCreatePrivateValue(
    brokerSecretPath,
    () => randomBytes(SECRET_BYTES).toString("base64url"),
    validateSecret,
  );
  const gatewaySecret = await loadOrCreatePrivateValue(
    join(stateDirectory, "gateway-secret"),
    () => (legacyIdentity ? brokerSecret : randomBytes(SECRET_BYTES).toString("base64url")),
    validateSecret,
  );
  const routeSalt = await loadOrCreatePrivateValue(
    join(stateDirectory, "route-salt"),
    () => randomBytes(SECRET_BYTES).toString("base64url"),
    validateSecret,
  );

  return { stateDirectory, machineId, brokerSecret, gatewaySecret, routeSalt };
}

export function createInstanceId(): string {
  return randomUUID();
}

export async function rotateGatewaySecret(
  stateDirectory = defaultStateDirectory(),
): Promise<string> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await assertPrivatePath(stateDirectory, "directory", 0o700);
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const path = join(stateDirectory, "gateway-secret");
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${secret}\n`, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await assertPrivatePath(path, "file", 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return secret;
}

export function createRouteGeneration(): string {
  return randomUUID();
}

export async function deriveProjectId(projectPath: string, routeSalt: string): Promise<string> {
  const canonicalPath = await realpath(projectPath);
  return createHmac("sha256", routeSalt).update(canonicalPath).digest("base64url");
}

export function createRouteKey(input: {
  machineId: string;
  instanceId: string;
  projectId: string;
  sessionId: string;
}): RouteKey {
  return {
    ...input,
    routeGeneration: createRouteGeneration(),
  };
}

async function loadOrCreatePrivateValue(
  path: string,
  generate: () => string,
  validate: (value: string) => string,
): Promise<string> {
  let created = false;
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(`${generate()}\n`, { encoding: "utf8" });
      created = true;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }

  await assertPrivatePath(path, "file", 0o600);
  if (created) return validate((await readFile(path, "utf8")).trim());

  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      return validate((await readFile(path, "utf8")).trim());
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function assertPrivatePath(
  path: string,
  expectedType: "directory" | "file",
  expectedMode: number,
): Promise<void> {
  const stats = await lstat(path);
  const typeMatches = expectedType === "directory" ? stats.isDirectory() : stats.isFile();
  if (!typeMatches || stats.isSymbolicLink()) {
    throw new Error(`${path} must be a regular ${expectedType}`);
  }

  if (platform() === "win32" || process.env.OPENCODE_TELEGRAM_CONTAINER === "1") return;

  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${path} permissions must not allow group or other access`);
  }

  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`${path} must be owned by the current user`);
  }

  if ((stats.mode & 0o777) !== expectedMode) {
    await chmod(path, expectedMode);
  }
}

function validateSecret(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== SECRET_BYTES) {
    throw new Error(`secret must contain ${SECRET_BYTES} bytes`);
  }
  return value;
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
