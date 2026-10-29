import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrokerServer, startBroker } from "../src/broker/server";
import { formatDoctorReport, runDoctor } from "../src/doctor";
import { BROKER_CAPABILITIES, BrokerEnvelopeSchema, PROTOCOL_VERSION } from "../src/protocol";
import { loadOrCreateStateIdentity } from "../src/state";
import { type TelegramBot, TelegramBotApi, type TelegramUpdate } from "../src/telegram";

const TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz_ABCD";
const temporaryDirectories: string[] = [];
const brokers: BrokerServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(brokers.splice(0).map((broker) => broker.stop()));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("doctor checks", () => {
  test("reports a healthy installation without exposing credentials", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const bindHost = "127.0.0.2";
    const broker = await startBroker({
      stateDirectory,
      port: 0,
      bindHost,
      idleTimeoutMs: 5_000,
      telegramApiFactory: () => new DoctorTelegramApi(),
    });
    brokers.push(broker);
    await registerPluginConnection(broker, stateDirectory, bindHost);

    const report = await runDoctor({
      stateDirectory,
      port: broker.port,
      bindHost,
      rawConfig: validConfig(),
      fetch: telegramFetch(),
      env: { OPENCODE_VERSION: "1.18.18" },
    });

    expect(report.ready).toBe(true);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    const output = formatDoctorReport(report);
    expect(output).toContain("Doctor readiness: ready");
    expect(output).not.toContain(TOKEN);
  });

  test("fails closed for invalid config and warns when broker or OpenCode version is unavailable", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const report = await runDoctor({
      stateDirectory,
      port: await availablePort(),
      rawConfig: {
        telegram: { botToken: TOKEN, userId: "123456789", chatId: "987654321" },
      },
      fetch: telegramFetch(),
      env: {},
    });

    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "configuration", status: "fail" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "broker-reachability", status: "warn" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "opencode-compatibility", status: "warn" }),
    );
    expect(formatDoctorReport(report)).not.toContain(TOKEN);
  });

  test("reports Telegram API failures as sanitized failures", async () => {
    const stateDirectory = await createTemporaryDirectory();

    const report = await runDoctor({
      stateDirectory,
      port: await availablePort(),
      rawConfig: validConfig(),
      fetch: failingTelegramFetch(),
      env: { OPENCODE_VERSION: "1.18.18" },
    });

    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "telegram-api", status: "fail" }),
    );
    expect(formatDoctorReport(report)).not.toContain(TOKEN);
  });

  test("validates a Node Gateway without requiring Telegram or admin credentials", async () => {
    const requests: Request[] = [];
    const report = await runDoctor({
      rawConfig: {
        role: "node",
        hostLabel: "laptop",
        gateway: { url: "ws://127.0.0.2:42617", secret: "node-secret" },
      },
      fetch: (async (input, init) => {
        requests.push(new Request(String(input), init));
        return new Response("unauthorized", { status: 401 });
      }) as typeof fetch,
      env: { OPENCODE_VERSION: "1.18.18" },
    });

    expect(report.ready).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "gateway-reachability", status: "pass" }),
    );
    expect(report.checks.some((check) => check.name === "telegram-api")).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.has("authorization")).toBe(false);
    expect(requests[0]?.url).toBe("http://127.0.0.2:42617/v1/health");
  });

  test("discovers Node role configuration when notifier environment variables are absent", async () => {
    const workspace = await createTemporaryDirectory();
    await writeFile(
      join(workspace, "opencode.json"),
      JSON.stringify({
        plugin: [
          [
            "opencode-telegram-link",
            {
              role: "node",
              hostLabel: "laptop",
              gateway: { url: "ws://127.0.0.2:42617", secret: "node-secret" },
            },
          ],
        ],
      }),
    );
    let requestedUrl = "";
    const report = await runDoctor({
      cwd: workspace,
      fetch: (async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return new Response("unauthorized", { status: 401 });
      }) as unknown as typeof fetch,
      env: {
        OPENCODE_VERSION: "1.18.18",
        OPENCODE_TELEGRAM_BROKER_PORT: "49999",
        OPENCODE_TELEGRAM_LOCALE: "en",
      },
    });

    expect(report.ready).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "gateway-reachability", status: "pass" }),
    );
    expect(report.checks.some((check) => check.name === "telegram-api")).toBe(false);
    expect(requestedUrl).toBe("http://127.0.0.2:49999/v1/health");
  });

  test("fails Gateway doctor before sending admin credentials to a public address", async () => {
    let publicAddressRequested = false;
    const report = await runDoctor({
      rawConfig: {
        broker: { host: "8.8.8.8", port: 42617 },
        telegram: { botToken: TOKEN, userId: "123456789", chatId: "123456789" },
      },
      port: await availablePort(),
      fetch: (async (input) => {
        if (String(input).includes("8.8.8.8")) publicAddressRequested = true;
        return Response.json({
          ok: true,
          result: { id: 42, is_bot: true, first_name: "Bot" },
        });
      }) as typeof fetch,
      env: { OPENCODE_VERSION: "1.18.18" },
    });

    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "configuration", status: "fail" }),
    );
    expect(publicAddressRequested).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "reports insecure token files as setup failures",
    async () => {
      const stateDirectory = await createTemporaryDirectory();
      const tokenFile = join(stateDirectory, "token");
      await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
      await chmod(tokenFile, 0o644);

      const report = await runDoctor({
        stateDirectory,
        port: await availablePort(),
        rawConfig: { telegram: { tokenFile, userId: "123456789", chatId: "123456789" } },
        fetch: telegramFetch(),
        env: { OPENCODE_VERSION: "1.18.18" },
      });

      expect(report.ready).toBe(false);
      expect(report.checks).toContainEqual(
        expect.objectContaining({ name: "secret-file", status: "fail" }),
      );
      expect(formatDoctorReport(report)).not.toContain(TOKEN);
      expect(formatDoctorReport(report)).not.toContain(tokenFile);
    },
  );

  test("reports incompatible OpenCode versions", async () => {
    const stateDirectory = await createTemporaryDirectory();

    const report = await runDoctor({
      stateDirectory,
      port: await availablePort(),
      rawConfig: validConfig(),
      fetch: telegramFetch(),
      env: { OPENCODE_VERSION: "1.17.9" },
    });

    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "opencode-compatibility", status: "fail" }),
    );
  });

  test("distinguishes offline and conflicting broker states", async () => {
    const stateDirectory = await createTemporaryDirectory();
    const offline = await runDoctor({
      stateDirectory,
      port: await availablePort(),
      rawConfig: validConfig(),
      fetch: telegramFetch(),
      env: { OPENCODE_VERSION: "1.18.18" },
    });
    expect(offline.checks).toContainEqual(
      expect.objectContaining({ name: "broker-reachability", status: "warn" }),
    );

    const occupied = Bun.serve({ port: 0, fetch: () => new Response("not a broker") });
    try {
      const conflicting = await runDoctor({
        stateDirectory,
        port: occupied.port ?? 0,
        rawConfig: validConfig(),
        fetch: telegramFetch(),
        env: { OPENCODE_VERSION: "1.18.18" },
      });
      expect(conflicting.checks).toContainEqual(
        expect.objectContaining({ name: "broker-singleton", status: "fail" }),
      );
    } finally {
      await occupied.stop(true);
    }
  });
});

function validConfig() {
  return {
    telegram: { botToken: TOKEN, userId: "123456789", chatId: "123456789" },
  };
}

async function registerPluginConnection(
  broker: BrokerServer,
  stateDirectory: string,
  bindHost = "127.0.0.1",
): Promise<void> {
  const identity = await loadOrCreateStateIdentity(stateDirectory);
  const socket = new WebSocket(`ws://${bindHost}:${broker.port}/v1/connect`, {
    headers: {
      authorization: `Bearer ${identity.gatewaySecret}`,
      "x-opencode-telegram-admin": `Bearer ${identity.brokerSecret}`,
    },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
      once: true,
    });
  });
  const response = waitForMessage(socket);
  socket.send(
    JSON.stringify({
      protocol: PROTOCOL_VERSION,
      type: "register",
      requestId: crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      payload: {
        packageVersion: "0.0.0",
        openCodeVersion: "1.18.18",
        machineId: broker.machineId,
        instanceId: crypto.randomUUID(),
        configFingerprint: "a".repeat(64),
        capabilities: [...BROKER_CAPABILITIES],
        telegram: {
          botToken: TOKEN,
          userId: "123456789",
          chatId: "123456789",
          locale: "en",
          sessionPromptTtlMinutes: 60,
          questionTtlMinutes: 30,
        },
      },
    }),
  );
  expect(await response).toMatchObject({ type: "registered" });
}

class DoctorTelegramApi extends TelegramBotApi {
  constructor() {
    super({ token: TOKEN, baseUrl: "https://telegram.invalid" });
  }

  override async getMe(): Promise<TelegramBot> {
    return { id: 42, is_bot: true, first_name: "Bot" };
  }

  override async deleteWebhook(): Promise<void> {}

  override async getUpdates(input: { signal?: AbortSignal }): Promise<TelegramUpdate[]> {
    await Bun.sleep(20);
    if (input.signal?.aborted) return [];
    return [];
  }
}

async function waitForMessage(socket: WebSocket) {
  return await new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          resolve(BrokerEnvelopeSchema.parse(JSON.parse(String(event.data))));
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
  });
}

function telegramFetch(): typeof fetch {
  return (async () =>
    Response.json({
      ok: true,
      result: { id: 42, is_bot: true, first_name: "Bot" },
    })) as unknown as typeof fetch;
}

function failingTelegramFetch(): typeof fetch {
  return (async () =>
    Response.json(
      { ok: false, error_code: 401, description: `bad ${TOKEN}` },
      { status: 401 },
    )) as unknown as typeof fetch;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-telegram-doctor-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function availablePort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port ?? 0;
  await reservation.stop(true);
  return port;
}
