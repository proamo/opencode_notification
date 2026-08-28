import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("broker container image contract", () => {
  test("defines a minimal non-root broker runtime with persistent state", async () => {
    const dockerfile = await readFile(join(root, "container", "broker.Dockerfile"), "utf8");

    expect(dockerfile).toContain("FROM oven/bun:1.3.14-slim AS runtime");
    expect(dockerfile).toContain("COPY dist ./dist");
    expect(dockerfile).toContain("OPENCODE_TELEGRAM_CONTAINER=1");
    expect(dockerfile).toContain("OPENCODE_TELEGRAM_BROKER_STATE_DIR=/state");
    expect(dockerfile).toContain("OPENCODE_TELEGRAM_BROKER_BIND_HOST=0.0.0.0");
    expect(dockerfile).toContain('VOLUME ["/state"]');
    expect(dockerfile).toContain("useradd -u 10001 -g opencode");
    expect(dockerfile).toContain("EXPOSE 42617/tcp");
    expect(dockerfile).toContain('ENTRYPOINT ["/app/entrypoint.sh"]');
    expect(dockerfile).not.toContain("OPENCODE_TELEGRAM_BOT_TOKEN=");
    expect(dockerfile).not.toContain("OPENCODE_TELEGRAM_CHAT_ID=");
  });

  test("keeps source, tests, and local state out of the Docker build context", async () => {
    const dockerignore = await readFile(join(root, ".dockerignore"), "utf8");

    expect(dockerignore).toContain("node_modules");
    expect(dockerignore).toContain("test");
    expect(dockerignore).toContain("src");
    expect(dockerignore).toContain(".gitnexus");
  });

  test("entrypoint.sh has valid POSIX shebang, no UTF-8 BOM, and adapts container UID to bind mount", async () => {
    const rawBuffer = await Bun.file(join(root, "container", "entrypoint.sh")).arrayBuffer();
    const bytes = new Uint8Array(rawBuffer);

    // Byte 0 and 1 must strictly be '#!' (0x23, 0x21) - NO UTF-8 BOM (0xEF, 0xBB, 0xBF)
    expect(bytes[0]).toBe(0x23);
    expect(bytes[1]).toBe(0x21);

    const script = new TextDecoder().decode(bytes);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).not.toContain("\r\n"); // POSIX LF line endings
    expect(script).toContain("STATE_UID=$(stat -c '%u' /state");
    expect(script).toContain('usermod -o -u "$STATE_UID" opencode');
    expect(script).toContain("exec gosu opencode bun /app/dist/broker/main.js");
  });
});
