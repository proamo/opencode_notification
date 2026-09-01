import { describe, expect, test } from "bun:test";
import { generateSystemdService, isSystemdAvailable } from "../src/service";

describe("Systemd Service Management", () => {
  test("generateSystemdService renders valid systemd unit file with custom options", () => {
    const unit = generateSystemdService({
      user: "testuser",
      home: "/home/testuser",
      execPath: "/usr/bin/bun",
      binScript: "/usr/bin/opencode-telegram-link",
      envPath: "/home/testuser/.bun/bin:/usr/bin",
    });

    expect(unit).toContain("Description=OpenCode Telegram Gateway & Commander");
    expect(unit).toContain("User=testuser");
    expect(unit).toContain("WorkingDirectory=/home/testuser");
    expect(unit).toContain("Environment=HOME=/home/testuser");
    expect(unit).toContain('Environment="PATH=/home/testuser/.bun/bin:/usr/bin"');
    expect(unit).toContain('Environment="OPENCODE_TELEGRAM_BROKER_BIND_HOST=0.0.0.0"');
    expect(unit).toContain(
      "ExecStart=/usr/bin/bun /usr/bin/opencode-telegram-link start --bind-host 0.0.0.0",
    );
    expect(unit).toContain("Restart=always");
  });

  test("isSystemdAvailable returns boolean without throwing", () => {
    const available = isSystemdAvailable();
    expect(typeof available).toBe("boolean");
  });
});
