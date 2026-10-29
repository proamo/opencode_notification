import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrokerCli } from "../src/broker/commands";
import { type BrokerServer, startBroker } from "../src/broker/server";
import { loadOrCreateStateIdentity, StateDatabase } from "../src/state";

const TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz_ABCD";
const temporaryDirectories: string[] = [];
const brokers: BrokerServer[] = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.stop()));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("broker lifecycle commands", () => {
  test("returns a sanitized CLI failure for an invalid bind address", async () => {
    const output = captureOutput();

    const status = await runBrokerCli({
      argv: ["status", "--bind-host", "not-an-ip"],
      ...output.streams,
    });

    expect(status).toBe(1);
    expect(output.stderr).toContain("bind host must be a valid IPv4 or IPv6 address");
  });

  test("rejects plaintext lifecycle credentials to a public bind address", async () => {
    const output = captureOutput();

    const status = await runBrokerCli({
      argv: ["status", "--bind-host", "8.8.8.8"],
      ...output.streams,
    });

    expect(status).toBe(1);
    expect(output.stderr).toContain("public bind hosts require a TLS reverse proxy");
  });

  test("reports stopped status without exposing secrets", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const output = captureOutput();

    const status = await runBrokerCli({
      argv: ["status", "--state-dir", stateDirectory, "--port", String(await availablePort())],
      ...output.streams,
    });

    expect(status).toBe(3);
    expect(output.stdout).toContain("stopped or unreachable");
    expect(output.stderr).toBe("");
  });

  test("reuses an existing broker and stops it through authenticated control", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const bindHost = "127.0.0.2";
    const broker = await startBroker({
      stateDirectory,
      port: 0,
      bindHost,
      idleTimeoutMs: 5_000,
    });
    brokers.push(broker);
    const output = captureOutput();

    await expect(
      runBrokerCli({
        argv: [
          "start",
          "--state-dir",
          stateDirectory,
          "--port",
          String(broker.port),
          "--bind-host",
          bindHost,
        ],
        ...output.streams,
      }),
    ).resolves.toBe(0);
    expect(output.stdout).toContain("already running");

    const stopOutput = captureOutput();
    await expect(
      runBrokerCli({
        argv: [
          "stop",
          "--state-dir",
          stateDirectory,
          "--port",
          String(broker.port),
          "--bind-host",
          bindHost,
        ],
        ...stopOutput.streams,
      }),
    ).resolves.toBe(0);
    expect(stopOutput.stdout).toContain("stop requested");
    await broker.finished;
  });

  test("refuses a competing endpoint for a persisted native deployment", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const managedPort = await availablePort();
    await writeFile(join(stateDirectory, "deployment.json"), JSON.stringify({ mode: "native" }), {
      mode: 0o600,
    });
    await writeFile(
      join(stateDirectory, "opencode-notifier.json"),
      JSON.stringify({ broker: { host: "10.147.20.130", port: managedPort } }),
      { mode: 0o600 },
    );
    const output = captureOutput();

    const status = await runBrokerCli({
      argv: [
        "start",
        "--state-dir",
        stateDirectory,
        "--bind-host",
        "127.0.0.1",
        "--port",
        String(managedPort),
      ],
      ...output.streams,
    });

    expect(status).toBe(1);
    expect(output.stderr).toContain("refusing competing Broker endpoint");
  });

  test("starts the exact endpoint recorded by native deployment ownership", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const port = await availablePort();
    await writeFile(
      join(stateDirectory, "deployment.json"),
      JSON.stringify({ mode: "native", bindHost: "127.0.0.2", port }),
      { mode: 0o600 },
    );
    const output = captureOutput();

    expect(
      await runBrokerCli({
        argv: [
          "start",
          "--state-dir",
          stateDirectory,
          "--bind-host",
          "127.0.0.2",
          "--port",
          String(port),
        ],
        onStarted: async (broker) => await broker.stop(),
        ...output.streams,
      }),
    ).toBeUndefined();
    expect(output.stdout).toContain("Broker started");
  });

  test("prefers native ownership over a stale persisted notifier endpoint", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const port = await availablePort();
    await writeFile(
      join(stateDirectory, "deployment.json"),
      JSON.stringify({ mode: "native", bindHost: "127.0.0.2", port }),
      { mode: 0o600 },
    );
    await writeFile(
      join(stateDirectory, "opencode-notifier.json"),
      JSON.stringify({ broker: { host: "127.0.0.3", port: port + 1 } }),
      { mode: 0o600 },
    );
    const output = captureOutput();

    expect(
      await runBrokerCli({
        argv: ["start", "--state-dir", stateDirectory],
        onStarted: async (broker) => await broker.stop(),
        ...output.streams,
      }),
    ).toBeUndefined();
    expect(output.stdout).toContain(`127.0.0.2:${port}`);
  });

  test("fails closed when native ownership has no endpoint source", async () => {
    const stateDirectory = await createTemporaryDirectory();
    await writeFile(join(stateDirectory, "deployment.json"), JSON.stringify({ mode: "native" }), {
      mode: 0o600,
    });
    const output = captureOutput();

    expect(
      await runBrokerCli({
        argv: ["start", "--state-dir", stateDirectory, "--port", String(await availablePort())],
        ...output.streams,
      }),
    ).toBe(1);
    expect(output.stderr).toContain("run setup to migrate deployment state");
  });

  test("refuses a host Broker for Docker and Node deployment ownership", async () => {
    for (const mode of ["docker", "node"]) {
      const stateDirectory = await createTemporaryDirectory();
      await writeFile(join(stateDirectory, "deployment.json"), JSON.stringify({ mode }), {
        mode: 0o600,
      });
      const output = captureOutput();

      expect(
        await runBrokerCli({
          argv: ["start", "--state-dir", stateDirectory, "--port", String(await availablePort())],
          ...output.streams,
        }),
      ).toBe(1);
      expect(output.stderr).toContain("does not own a host Broker process");
    }
  });

  test("allows the container process to start for Docker deployment ownership", async () => {
    const stateDirectory = await createTemporaryDirectory();
    await writeFile(join(stateDirectory, "deployment.json"), JSON.stringify({ mode: "docker" }), {
      mode: 0o600,
    });
    const output = captureOutput();

    expect(
      await runBrokerCli({
        argv: ["start", "--state-dir", stateDirectory, "--port", String(await availablePort())],
        env: { OPENCODE_TELEGRAM_CONTAINER: "1" },
        onStarted: async (broker) => await broker.stop(),
        ...output.streams,
      }),
    ).toBeUndefined();
    expect(output.stdout).toContain("Broker started");
  });

  test("fails closed for a dangling deployment ownership marker", async () => {
    const stateDirectory = await createTemporaryDirectory();
    await symlink(join(stateDirectory, "missing-marker"), join(stateDirectory, "deployment.json"));
    const output = captureOutput();

    expect(
      await runBrokerCli({
        argv: ["start", "--state-dir", stateDirectory, "--port", String(await availablePort())],
        ...output.streams,
      }),
    ).toBe(1);
    expect(output.stderr).toContain("deployment ownership marker is not a private");
  });

  test("uses the private persisted endpoint and refuses to purge a live broker", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const bindHost = "127.0.0.2";
    const broker = await startBroker({ stateDirectory, bindHost, port: 0, idleTimeoutMs: 5_000 });
    brokers.push(broker);
    const persistedPath = join(stateDirectory, "opencode-notifier.json");
    await writeFile(
      persistedPath,
      JSON.stringify({ broker: { host: bindHost, port: broker.port } }),
    );
    await chmod(persistedPath, 0o600);

    const purgeOutput = captureOutput();
    expect(
      await runBrokerCli({
        argv: ["purge-state", "--state-dir", stateDirectory],
        ...purgeOutput.streams,
      }),
    ).toBe(1);
    expect(purgeOutput.stderr).toContain("Stop the broker before purging state");

    const stopOutput = captureOutput();
    expect(
      await runBrokerCli({
        argv: ["stop", "--state-dir", stateDirectory],
        ...stopOutput.streams,
      }),
    ).toBe(0);
    await broker.finished;
  });

  test("purges operational state while preserving identity", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const identity = await loadOrCreateStateIdentity(stateDirectory);
    const database = await StateDatabase.open({ stateDirectory, machineId: identity.machineId });
    database.commitInboundUpdate({ updateId: 12, disposition: "acknowledged", occurredAt: 1_000 });
    database.claimNotification("event_1", 10_000, 1_000);
    database.close();
    const output = captureOutput();

    const status = await runBrokerCli({
      argv: ["purge-state", "--state-dir", stateDirectory, "--port", String(await availablePort())],
      ...output.streams,
    });

    expect(status).toBe(0);
    expect(output.stdout).toContain("Purged operational state");
    const after = await StateDatabase.open({ stateDirectory, machineId: identity.machineId });
    try {
      expect(after.inspect()).toMatchObject({ inboundUpdates: 0, dedupeRecords: 0 });
      expect(after.inspect().machineId).toBe(identity.machineId);
    } finally {
      after.close();
    }
  });

  test("rotates only the node gateway credential", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const before = await loadOrCreateStateIdentity(stateDirectory);
    const output = captureOutput();

    const status = await runBrokerCli({
      argv: ["rotate-gateway-secret", "--state-dir", stateDirectory],
      ...output.streams,
    });
    const after = await loadOrCreateStateIdentity(stateDirectory);

    expect(status).toBe(0);
    expect(after.gatewaySecret).not.toBe(before.gatewaySecret);
    expect(after.brokerSecret).toBe(before.brokerSecret);
    expect(output.stdout).not.toContain(after.gatewaySecret);
  });

  test("rotates credentials into a private token file", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const tokenFile = join(stateDirectory, "rotated-token");
    const output = captureOutput();

    const status = await runBrokerCli({
      argv: ["rotate-credential", "--state-dir", stateDirectory, "--token-file", tokenFile],
      env: { OPENCODE_TELEGRAM_BOT_TOKEN: TOKEN },
      ...output.streams,
    });

    expect(status).toBe(0);
    expect(output.stdout).toContain("Credential rotated");
    expect(output.stdout).not.toContain(TOKEN);
    expect(await readFile(tokenFile, "utf8")).toBe(`${TOKEN}\n`);
    if (process.platform !== "win32") {
      expect((await lstat(tokenFile)).mode & 0o077).toBe(0);
    }
  });

  test("sends a non-actionable test notification", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const output = captureOutput();

    const status = await runBrokerCli({
      argv: ["test-notification", "--chat-id", "123456789", "--locale", "zh-TW"],
      env: { OPENCODE_TELEGRAM_BOT_TOKEN: TOKEN },
      fetch: telegramFetch(requests),
      ...output.streams,
    });

    expect(status).toBe(0);
    expect(output.stdout).toContain("Test notification sent");
    expect(requests).toEqual([
      { method: "getMe", body: {} },
      {
        method: "sendMessage",
        body: {
          chat_id: "123456789",
          text: "OpenCode Telegram Link 測試通知。此訊息不包含 session 內容，也不會建立可路由互動。",
          disable_notification: true,
        },
      },
    ]);
  });

  test("runs doctor and returns warnings when broker is stopped", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const output = captureOutput();

    const status = await runBrokerCli({
      argv: ["doctor", "--state-dir", stateDirectory, "--port", String(await availablePort())],
      env: {
        OPENCODE_TELEGRAM_BOT_TOKEN: TOKEN,
        OPENCODE_TELEGRAM_USER_ID: "123456789",
        OPENCODE_TELEGRAM_CHAT_ID: "123456789",
        OPENCODE_VERSION: "1.18.18",
      },
      fetch: telegramFetch([]),
      ...output.streams,
    });

    expect(status).toBe(2);
    expect(output.stdout).toContain("Doctor readiness: not ready");
    expect(output.stdout).toContain("WARN broker-reachability");
    expect(output.stdout).not.toContain(TOKEN);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-telegram-broker-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function availablePort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port ?? 0;
  await reservation.stop(true);
  return port;
}

function captureOutput() {
  const output = { stdout: "", stderr: "" };
  return {
    get stdout() {
      return output.stdout;
    },
    get stderr() {
      return output.stderr;
    },
    streams: {
      stdout: {
        write: (chunk: string | Uint8Array) => {
          output.stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          output.stderr += String(chunk);
          return true;
        },
      },
    },
  };
}

function telegramFetch(
  requests: Array<{ method: string; body: Record<string, unknown> }>,
): typeof fetch {
  return (async (url, init) => {
    const method = String(url).split("/").pop();
    if (!method) throw new Error("missing Telegram method");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ method, body });
    if (method === "getMe") {
      return Response.json({ ok: true, result: { id: 42, is_bot: true, first_name: "Bot" } });
    }
    if (method === "sendMessage") {
      return Response.json({
        ok: true,
        result: {
          message_id: 99,
          chat: { id: Number(body.chat_id), type: "private" },
          date: 1_700_000_000,
        },
      });
    }
    return Response.json({ ok: false, error_code: 404, description: "not found" }, { status: 404 });
  }) as typeof fetch;
}
