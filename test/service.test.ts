import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateSystemdService,
  installSystemdService,
  isSystemdAvailable,
  uninstallSystemdService,
} from "../src/service";

describe("Systemd Service Management", () => {
  test("generateSystemdService renders valid systemd unit file with custom options", () => {
    const unit = generateSystemdService({
      user: "testuser",
      home: "/home/testuser",
      execPath: "/usr/bin/bun",
      binScript: "/usr/bin/opencode-telegram-link",
      envPath: "/home/testuser/.bun/bin:/usr/bin",
      bindHost: "10.147.20.130",
      stateDirectory: "/home/testuser/.local/state/opencode-telegram-link",
    });

    expect(unit).toContain("Description=OpenCode Telegram Gateway & Commander");
    expect(unit).toContain("User=testuser");
    expect(unit).toContain("WorkingDirectory=/home/testuser");
    expect(unit).toContain('Environment="HOME=/home/testuser"');
    expect(unit).toContain('Environment="PATH=/home/testuser/.bun/bin:/usr/bin"');
    expect(unit).toContain('Environment="OPENCODE_TELEGRAM_BROKER_BIND_HOST=10.147.20.130"');
    expect(unit).toContain(
      'ExecStart="/usr/bin/bun" "/usr/bin/opencode-telegram-link" start --bind-host "10.147.20.130"',
    );
    expect(unit).toContain("Restart=on-failure");
  });

  test("isSystemdAvailable returns boolean without throwing", () => {
    const available = isSystemdAvailable();
    expect(typeof available).toBe("boolean");
  });

  test("rejects unsafe unit values", () => {
    expect(() => generateSystemdService({ home: "/home/test\nInjected=true" })).toThrow(
      "forbidden character",
    );
  });

  test("reports systemctl disable failures without claiming removal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-service-test-"));
    const serviceFile = join(directory, "opencode-gateway.service");
    await writeFile(serviceFile, "[Service]\n", "utf8");
    try {
      const result = await uninstallSystemdService({
        serviceFile,
        spawnSync: () => ({
          exitCode: 1,
          stderr: new TextEncoder().encode("permission denied"),
        }),
      });

      expect(result).toEqual({
        success: false,
        removed: false,
        error: "permission denied",
      });
      expect(await Bun.file(serviceFile).exists()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("installs a stable private broker bundle instead of an npx cache path", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "opencode-service-install-test-"));
    const serviceFile = join(stateDirectory, "opencode-gateway.service");
    const commands: string[][] = [];
    try {
      const result = await installSystemdService({
        stateDirectory,
        serviceFile,
        bindHost: "10.147.20.130",
        spawnSync: (command) => {
          commands.push(command);
          return { exitCode: 0 };
        },
      });

      expect(result).toEqual({ success: true });
      const installedEntry = join(stateDirectory, "service", "opencode-telegram-broker.js");
      expect(await Bun.file(installedEntry).exists()).toBe(true);
      expect(commands).toHaveLength(5);
      expect(commands[0]?.join(" ")).toContain("opencode-gateway");
      expect(commands[3]?.join(" ")).toContain("restart opencode-gateway");
      expect(commands[4]?.join(" ")).toContain("is-active --quiet opencode-gateway");
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("restores the previous bundle and unit when restart fails", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "opencode-service-rollback-test-"));
    const serviceDirectory = join(stateDirectory, "service");
    const serviceFile = join(stateDirectory, "opencode-gateway.service");
    await mkdir(serviceDirectory, { recursive: true });
    await Bun.write(join(serviceDirectory, "opencode-telegram-broker.js"), "old bundle");
    await Bun.write(serviceFile, "old unit");
    let restartCalls = 0;
    try {
      const result = await installSystemdService({
        stateDirectory,
        serviceFile,
        spawnSync: (command) => {
          if (command.includes("restart")) {
            restartCalls += 1;
            if (restartCalls === 1) {
              return { exitCode: 1, stderr: new TextEncoder().encode("restart failed") };
            }
          }
          return { exitCode: 0 };
        },
      });

      expect(result).toEqual({ success: false, error: "restart failed" });
      expect(await Bun.file(join(serviceDirectory, "opencode-telegram-broker.js")).text()).toBe(
        "old bundle",
      );
      expect(await Bun.file(serviceFile).text()).toBe("old unit");
      expect(restartCalls).toBe(2);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("rolls back when the restarted systemd service does not remain active", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "opencode-service-inactive-test-"));
    const serviceDirectory = join(stateDirectory, "service");
    const serviceFile = join(stateDirectory, "opencode-gateway.service");
    const installedEntry = join(serviceDirectory, "opencode-telegram-broker.js");
    await mkdir(serviceDirectory, { recursive: true });
    await Bun.write(installedEntry, "old-bundle\n");
    await Bun.write(serviceFile, "old-unit\n");
    let restartCalls = 0;
    try {
      const result = await installSystemdService({
        stateDirectory,
        serviceFile,
        spawnSync: (command) => {
          if (command.includes("restart")) restartCalls += 1;
          if (command.includes("is-active")) {
            return { exitCode: 3, stderr: new TextEncoder().encode("inactive") };
          }
          return { exitCode: 0 };
        },
      });

      expect(result).toEqual({
        success: false,
        error: "inactive",
      });
      expect(await Bun.file(serviceFile).text()).toBe("old-unit\n");
      expect(await Bun.file(installedEntry).text()).toBe("old-bundle\n");
      expect(restartCalls).toBe(2);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("disables a fresh unit and reports rollback failures when restart fails", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "opencode-service-fresh-rollback-test-"));
    const serviceFile = join(stateDirectory, "opencode-gateway.service");
    const commands: string[][] = [];
    try {
      const result = await installSystemdService({
        stateDirectory,
        serviceFile,
        spawnSync: (command) => {
          commands.push(command);
          if (command.includes("restart")) {
            return { exitCode: 1, stderr: new TextEncoder().encode("restart failed") };
          }
          if (command.includes("disable")) {
            return { exitCode: 1, stderr: new TextEncoder().encode("disable failed") };
          }
          return { exitCode: 0 };
        },
      });

      expect(result).toEqual({
        success: false,
        error: "restart failed; rollback failed: disable failed",
      });
      expect(commands.some((command) => command.includes("disable"))).toBe(true);
      expect(commands.filter((command) => command.includes("restart"))).toHaveLength(1);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
