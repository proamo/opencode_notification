import { describe, expect, test } from "bun:test";
import type { NormalizedNotification, RouteKey } from "../src/protocol";
import {
  redactText,
  renderTelegramNotification,
  sanitizeTelegramText,
  TelegramRenderError,
} from "../src/telegram";

const route: RouteKey = {
  machineId: crypto.randomUUID(),
  instanceId: crypto.randomUUID(),
  projectId: "opaque-project-id-value",
  sessionId: "ses_123",
  routeGeneration: crypto.randomUUID(),
};

describe("renderTelegramNotification", () => {
  test("renders only allowlisted notification fields with escaped HTML", () => {
    const payload = renderTelegramNotification(
      notification({
        kind: "session.completed",
        projectLabel: "api <prod>",
        sessionLabel: "fix & test",
      }),
    );

    expect(payload.parseMode).toBe("HTML");
    expect(payload.text).toContain("<b>Task completed</b>");
    expect(payload.text).toContain("api &lt;prod&gt;");
    expect(payload.text).toContain("fix &amp; test");
    expect(payload.text).not.toContain("machineId");
    expect(payload.text).not.toContain(route.routeGeneration);
  });

  test("renders Traditional Chinese localization when locale is zh-TW", () => {
    const payload = renderTelegramNotification(
      notification({
        kind: "session.completed",
        locale: "zh-TW",
        projectLabel: "api-service",
        sessionLabel: "測試任務",
      }),
    );
    expect(payload.parseMode).toBe("HTML");
    expect(payload.text).toContain("<b>工作已完成</b>");
    expect(payload.text).toContain("專案: api-service");
    expect(payload.text).toContain("Session: 測試任務");
    expect(payload.text).toContain("狀態：已完成");
  });

  test("fails closed for unsupported notification models", () => {
    expect(() =>
      renderTelegramNotification({
        kind: "tool.output",
        output: "secret output",
      }),
    ).toThrow(TelegramRenderError);
  });

  test("redacts secrets and paths before rendering question content", () => {
    const payload = renderTelegramNotification(
      notification({
        kind: "question.pending",
        interactionId: "question_1",
        questions: [
          {
            header: "Token",
            question:
              "Use token=sk-proj-abcdefghijklmnopqrstuvwxyz123456 at /home/amo/private/project?",
            options: [
              {
                label: "Bearer abcdefghijklmnopqrstuvwxyz123456",
                description: "123456789:abcdefghijklmnopqrstuvwxyz_ABCD",
              },
            ],
            multiple: false,
            custom: true,
          },
        ],
      }),
    );

    expect(payload.text).toContain("[redacted]");
    expect(payload.text).not.toContain("sk-proj");
    expect(payload.text).not.toContain("/home/amo/private/project");
    expect(payload.text).not.toContain("123456789:abcdefghijklmnopqrstuvwxyz_ABCD");
  });

  test("uses compact HTML truncation and safe plain-text fallback", () => {
    const longQuestion = "x".repeat(4_000);
    const compact = renderTelegramNotification(
      notification({
        kind: "question.pending",
        interactionId: "question_1",
        questions: [
          { header: "Long", question: longQuestion, options: [], multiple: false, custom: true },
        ],
      }),
      { maxLength: 500 },
    );
    expect(compact.parseMode).toBe("HTML");
    expect(compact.text.length).toBeLessThanOrEqual(500);
    expect(compact.text).not.toContain(longQuestion);

    const fallback = renderTelegramNotification(notification({ kind: "session.completed" }), {
      maxLength: 80,
    });
    expect(fallback.parseMode).toBeUndefined();
    expect(fallback.text.length).toBeLessThanOrEqual(80);
    expect(fallback.text).toContain("Task completed");
  });

  test("supports configured redaction patterns", () => {
    const payload = renderTelegramNotification(notification({ sessionLabel: "customer ACME-42" }), {
      redactionPatterns: [/ACME-\d+/g],
    });

    expect(payload.text).toContain("customer [redacted]");
    expect(payload.text).not.toContain("ACME-42");
  });
});

describe("redaction helpers", () => {
  test("apply the same redaction before final outbox delivery", () => {
    const text = sanitizeTelegramText("token=sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(text).toBe("[redacted]");
    expect(redactText("Bearer abcdefghijklmnopqrstuvwxyz123456")).toBe("[redacted]");
  });
});

function notification(input: Partial<NormalizedNotification> = {}): NormalizedNotification {
  return {
    kind: "session.completed",
    eventId: "event_1",
    route,
    locale: "en",
    projectLabel: "backend-api",
    sessionLabel: "Implement notifications",
    occurredAt: "2026-08-19T12:00:00.000Z",
    ...input,
  } as NormalizedNotification;
}
