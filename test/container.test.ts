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
    expect(dockerfile).toContain("OPENCODE_TELEGRAM_BROKER_STATE_DIR=/state");
    expect(dockerfile).toContain("OPENCODE_TELEGRAM_BROKER_BIND_HOST=0.0.0.0");
    expect(dockerfile).toContain('VOLUME ["/state"]');
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain("EXPOSE 42617/tcp");
    expect(dockerfile).toContain('ENTRYPOINT ["bun", "/app/dist/broker/main.js"]');
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
});
