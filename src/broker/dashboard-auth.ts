import { createHmac, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DASHBOARD_SESSION_COOKIE = "opencode_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

export function dashboardPasswordPath(stateDirectory: string): string {
  return join(stateDirectory, "dashboard-password");
}

export async function readDashboardPasswordHash(
  stateDirectory: string,
): Promise<string | undefined> {
  const value = await readFile(dashboardPasswordPath(stateDirectory), "utf8").catch(() => "");
  return value.trim() || undefined;
}

export async function setDashboardPassword(
  stateDirectory: string,
  password: string,
): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`dashboard password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const path = dashboardPasswordPath(stateDirectory);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${hash}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function verifyDashboardPassword(hash: string, password: string): Promise<boolean> {
  return await Bun.password.verify(password, hash).catch(() => false);
}

export function issueDashboardSession(
  brokerSecret: string,
  passwordHash: string,
  now = Date.now(),
): string {
  const expiresAt = now + SESSION_TTL_MS;
  return `v1.${expiresAt}.${sign(brokerSecret, passwordHash, expiresAt)}`;
}

export function verifyDashboardSession(
  value: string,
  brokerSecret: string,
  passwordHash: string,
  now = Date.now(),
): boolean {
  const [version, expiry, signature] = value.split(".");
  const expiresAt = Number(expiry);
  if (version !== "v1" || !signature || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    return false;
  }
  const expected = Buffer.from(sign(brokerSecret, passwordHash, expiresAt));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function dashboardSessionCookie(
  value: string,
  maxAgeSeconds = SESSION_TTL_MS / 1000,
): string {
  return `${DASHBOARD_SESSION_COOKIE}=${value}; Path=/; SameSite=Strict; HttpOnly; Max-Age=${maxAgeSeconds}`;
}

export class LoginRateLimiter {
  readonly #failures = new Map<string, number[]>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 5 * 60 * 1000,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    return this.#recent(key, now).length >= this.limit;
  }

  fail(key: string, now = Date.now()): void {
    this.#failures.set(key, [...this.#recent(key, now), now]);
  }

  reset(key: string): void {
    this.#failures.delete(key);
  }

  #recent(key: string, now: number): number[] {
    return (this.#failures.get(key) ?? []).filter((at) => now - at < this.windowMs);
  }
}

function sign(brokerSecret: string, passwordHash: string, expiresAt: number): string {
  return createHmac("sha256", `${brokerSecret}\0${passwordHash}`)
    .update(`dashboard-session\0${expiresAt}`)
    .digest("base64url");
}
