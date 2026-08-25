import { describe, expect, test } from "bun:test";
import { normalizeOpenCodeEvent, OpenCodeEventBridge } from "../src/opencode";
import type { RouteIntent } from "../src/plugin/client";
import {
  type NormalizedNotification,
  NormalizedNotificationSchema,
  type RouteKey,
} from "../src/protocol";

describe("normalizeOpenCodeEvent", () => {
  test("normalizes legacy and ID-bearing completion events", () => {
    expect(
      normalizeOpenCodeEvent({ type: "session.idle", properties: { sessionID: "ses_1" } }),
    ).toEqual({
      status: "notification",
      event: { kind: "session.completed", sessionId: "ses_1" },
    });
    expect(
      normalizeOpenCodeEvent({
        id: "evt_1",
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      }),
    ).toEqual({
      status: "notification",
      event: { kind: "session.completed", sessionId: "ses_1", sourceEventId: "evt_1" },
    });
  });

  test("normalizes errors to allowlisted categories without copying error data", () => {
    expect(
      normalizeOpenCodeEvent({
        id: "evt_error",
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          error: { name: "APIError", data: { message: "secret provider response" } },
        },
      }),
    ).toEqual({
      status: "notification",
      event: {
        kind: "session.error",
        sessionId: "ses_1",
        errorCategory: "api",
        sourceEventId: "evt_error",
      },
    });
  });

  test.each(["question.asked", "question.v2.asked"])("normalizes %s", (type) => {
    const result = normalizeOpenCodeEvent({
      id: "evt_question",
      type,
      properties: {
        id: "question_1",
        sessionID: "ses_1",
        questions: [
          {
            question: "Choose a database",
            header: "Database",
            options: [
              { label: "SQLite", description: "Local database" },
              { label: "Postgres", description: "Server database" },
            ],
          },
        ],
      },
    });

    expect(result).toEqual({
      status: "notification",
      event: {
        kind: "question.pending",
        sessionId: "ses_1",
        interactionId: "question_1",
        sourceEventId: "evt_question",
        questions: [
          {
            question: "Choose a database",
            header: "Database",
            options: [
              { label: "SQLite", description: "Local database" },
              { label: "Postgres", description: "Server database" },
            ],
            multiple: false,
            custom: true,
          },
        ],
      },
    });
  });

  test.each([
    ["permission.updated", { id: "perm_1", sessionID: "ses_1", type: "bash" }],
    ["permission.asked", { id: "perm_1", sessionID: "ses_1", permission: "external_directory" }],
    ["permission.v2.asked", { id: "perm_1", sessionID: "ses_1", action: "edit" }],
  ] as const)("normalizes %s", (type, properties) => {
    expect(normalizeOpenCodeEvent({ id: "evt_permission", type, properties })).toEqual({
      status: "notification",
      event: {
        kind: "permission.pending",
        sessionId: "ses_1",
        interactionId: "perm_1",
        permissionCategory:
          "type" in properties
            ? properties.type
            : "permission" in properties
              ? properties.permission
              : properties.action,
        sourceEventId: "evt_permission",
      },
    });
  });

  test("normalizes session metadata used for routing", () => {
    expect(
      normalizeOpenCodeEvent({
        type: "session.created",
        properties: { info: { id: "ses_child", title: "Child task", parentID: "ses_root" } },
      }),
    ).toEqual({
      status: "session",
      event: {
        kind: "session.upsert",
        sessionId: "ses_child",
        title: "Child task",
        parentId: "ses_root",
      },
    });
  });

  test("fails closed for malformed known events and ignores unrelated events", () => {
    expect(normalizeOpenCodeEvent({ type: "session.error", properties: {} })).toEqual({
      status: "invalid",
      eventType: "session.error",
      code: "INCOMPATIBLE_EVENT_PAYLOAD",
    });
    expect(
      normalizeOpenCodeEvent({ type: "file.edited", properties: { file: "secret.env" } }),
    ).toEqual({ status: "ignored" });
  });
});

describe("OpenCodeEventBridge", () => {
  test("registers sessions and creates schema-valid notifications on the exact active route", async () => {
    const broker = new FakeRouteClient();
    const notifications: NormalizedNotification[] = [];
    const bridge = new OpenCodeEventBridge({
      broker,
      projectId: "opaque-project-id",
      projectLabel: "backend",
      locale: "zh-TW",
      completionDebounceMs: 0,
      now: () => new Date("2026-08-18T12:00:00.000Z"),
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });

    await bridge.handle(sessionCreated("ses_root", "Main task"));
    await bridge.handle({
      id: "evt_1",
      type: "session.idle",
      properties: { sessionID: "ses_root" },
    });
    await waitForNotifications(notifications, 1);

    expect(broker.routes).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    const notification = notifications[0];
    if (!notification) throw new Error("expected normalized notification");
    expect(NormalizedNotificationSchema.parse(notification)).toEqual(notification);
    expect(notification).toMatchObject({
      kind: "session.completed",
      eventId: "evt_1",
      locale: "zh-TW",
      projectLabel: "backend",
      sessionLabel: "Main task",
      route: { sessionId: "ses_root" },
    });
  });

  test("embeds summary in session.completed notification when fetchSummary is provided", async () => {
    const broker = new FakeRouteClient();
    const notifications: NormalizedNotification[] = [];
    const bridge = new OpenCodeEventBridge({
      broker,
      projectId: "opaque-project-id",
      projectLabel: "backend",
      locale: "zh-TW",
      completionDebounceMs: 0,
      fetchSummary: async (sessionId) => `Summary for ${sessionId}`,
      now: () => new Date("2026-08-18T12:00:00.000Z"),
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });

    await bridge.handle(sessionCreated("ses_root", "Main task"));
    await bridge.handle({
      id: "evt_summary",
      type: "session.idle",
      properties: { sessionID: "ses_root" },
    });
    await waitForNotifications(notifications, 1);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "session.completed",
      eventId: "evt_summary",
      summary: "Summary for ses_root",
    });
  });

  test("keeps a child question on its originating route and identifies root context", async () => {
    const broker = new FakeRouteClient();
    const notifications: NormalizedNotification[] = [];
    const bridge = new OpenCodeEventBridge({
      broker,
      projectId: "opaque-project-id",
      projectLabel: "backend",
      locale: "en",
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });
    await bridge.handle(sessionCreated("ses_root", "Main task"));
    await bridge.handle(sessionCreated("ses_child", "Explore code", "ses_root"));

    await bridge.handle({
      type: "question.asked",
      properties: {
        id: "question_1",
        sessionID: "ses_child",
        questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }],
      },
    });
    await waitForNotifications(notifications, 1);

    expect(notifications[0]).toMatchObject({
      kind: "question.pending",
      rootSessionLabel: "Main task",
      sessionLabel: "Explore code",
      route: { sessionId: "ses_child" },
      interactionId: "question_1",
    });
  });

  test("removes deleted routes and reports missing or malformed routing without notification", async () => {
    const broker = new FakeRouteClient();
    const notifications: NormalizedNotification[] = [];
    const diagnostics: Array<[string, string]> = [];
    const bridge = new OpenCodeEventBridge({
      broker,
      projectId: "opaque-project-id",
      projectLabel: "backend",
      locale: "en",
      completionDebounceMs: 0,
      onNotification: (notification) => {
        notifications.push(notification);
      },
      onDiagnostic: (code, eventType) => diagnostics.push([code, eventType]),
    });
    await bridge.handle(sessionCreated("ses_1", "Task"));
    await bridge.handle({
      type: "session.deleted",
      properties: { info: { id: "ses_1", title: "Task" } },
    });
    await bridge.handle({ type: "session.idle", properties: { sessionID: "ses_1" } });
    await bridge.handle({ type: "session.error", properties: {} });

    expect(broker.routes).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(diagnostics).toEqual([["INCOMPATIBLE_EVENT_PAYLOAD", "session.error"]]);
  });

  test("suppresses child lifecycle notifications while keeping root lifecycle enabled", async () => {
    const broker = new FakeRouteClient();
    const notifications: NormalizedNotification[] = [];
    const bridge = new OpenCodeEventBridge({
      broker,
      projectId: "opaque-project-id",
      projectLabel: "backend",
      locale: "en",
      completionDebounceMs: 0,
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });
    await bridge.handle(sessionCreated("ses_root", "Main task"));
    await bridge.handle(sessionCreated("ses_child", "Explore code", "ses_root"));

    await bridge.handle({ type: "session.idle", properties: { sessionID: "ses_child" } });
    await bridge.handle({ type: "session.idle", properties: { sessionID: "ses_root" } });
    await waitForNotifications(notifications, 1);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "session.completed",
      route: { sessionId: "ses_root" },
    });
  });

  test("cancels a debounced completion when the session becomes active again", async () => {
    const broker = new FakeRouteClient();
    const notifications: NormalizedNotification[] = [];
    const bridge = new OpenCodeEventBridge({
      broker,
      projectId: "opaque-project-id",
      projectLabel: "backend",
      locale: "en",
      completionDebounceMs: 30,
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });
    await bridge.handle(sessionCreated("ses_root", "Main task"));
    await bridge.handle({ type: "session.idle", properties: { sessionID: "ses_root" } });
    await bridge.handle({
      type: "session.status",
      properties: { sessionID: "ses_root", status: { type: "busy" } },
    });
    await Bun.sleep(50);

    expect(notifications).toHaveLength(0);
  });

  test("does not cancel debounced completion when session.updated is emitted after session.idle", async () => {
    const broker = new FakeRouteClient();
    const notifications: NormalizedNotification[] = [];
    const bridge = new OpenCodeEventBridge({
      broker,
      projectId: "opaque-project-id",
      projectLabel: "backend",
      locale: "en",
      completionDebounceMs: 30,
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });
    await bridge.handle(sessionCreated("ses_root", "Main task"));
    await bridge.handle({ type: "session.idle", properties: { sessionID: "ses_root" } });
    await bridge.handle(sessionCreated("ses_root", "Main task updated"));
    await Bun.sleep(60);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.kind).toBe("session.completed");
  });

  test("flushes a debounced completion before plugin shutdown", async () => {
    const broker = new FakeRouteClient();
    const notifications: NormalizedNotification[] = [];
    const bridge = new OpenCodeEventBridge({
      broker,
      projectId: "opaque-project-id",
      projectLabel: "backend",
      locale: "en",
      completionDebounceMs: 30_000,
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });
    await bridge.handle(sessionCreated("ses_root", "Main task"));
    await bridge.handle({ type: "session.idle", properties: { sessionID: "ses_root" } });

    await bridge.flush();
    bridge.dispose();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "session.completed" });
  });

  test("deduplicates repeated observations of the same source event and route", async () => {
    const broker = new FakeRouteClient();
    const notifications: NormalizedNotification[] = [];
    const bridge = new OpenCodeEventBridge({
      broker,
      projectId: "opaque-project-id",
      projectLabel: "backend",
      locale: "en",
      completionDebounceMs: 0,
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });
    await bridge.handle(sessionCreated("ses_root", "Main task"));
    const event = { id: "evt_1", type: "session.idle", properties: { sessionID: "ses_root" } };

    await bridge.handle(event);
    await bridge.handle(event);
    await waitForNotifications(notifications, 1);
    await Bun.sleep(5);

    expect(notifications).toHaveLength(1);
  });

  test("buffers notifications by priority, retries delivery, and drops low-priority overflow", async () => {
    const broker = new FakeRouteClient();
    const notifications: NormalizedNotification[] = [];
    const diagnostics: Array<[string, string]> = [];
    let failing = true;
    const bridge = new OpenCodeEventBridge({
      broker,
      projectId: "opaque-project-id",
      projectLabel: "backend",
      locale: "en",
      completionDebounceMs: 0,
      bufferLimit: 2,
      onNotification: async (notification) => {
        if (failing) throw new Error("broker unavailable");
        notifications.push(notification);
      },
      onDiagnostic: (code, eventType) => diagnostics.push([code, eventType]),
    });
    await bridge.handle(sessionCreated("ses_root", "Main task"));
    await bridge.handle({
      id: "evt_done",
      type: "session.idle",
      properties: { sessionID: "ses_root" },
    });
    await bridge.handle({
      id: "evt_error",
      type: "session.error",
      properties: { sessionID: "ses_root", error: { name: "APIError" } },
    });
    await bridge.handle({
      id: "evt_question",
      type: "question.asked",
      properties: {
        id: "question_1",
        sessionID: "ses_root",
        questions: [{ question: "Continue?", header: "Continue", options: [] }],
      },
    });
    await Bun.sleep(5);
    failing = false;
    await waitForNotifications(notifications, 2, 1_000);

    expect(notifications.map((notification) => notification.kind)).toEqual([
      "question.pending",
      "session.error",
    ]);
    expect(diagnostics).toContainEqual(["NOTIFICATION_BUFFER_OVERFLOW", "session.completed"]);
    expect(diagnostics).toContainEqual(["NOTIFICATION_BUFFERED", "question.pending"]);
  });

  test("buffers source events until the exact route is available", async () => {
    const broker = new FakeRouteClient();
    broker.online = false;
    const notifications: NormalizedNotification[] = [];
    const bridge = new OpenCodeEventBridge({
      broker,
      projectId: "opaque-project-id",
      projectLabel: "backend",
      locale: "en",
      bufferLimit: 3,
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });
    await bridge.handle(sessionCreated("ses_root", "Main task"));
    await bridge.handle({
      id: "evt_question",
      type: "question.asked",
      properties: {
        id: "question_1",
        sessionID: "ses_root",
        questions: [{ question: "Continue?", header: "Continue", options: [] }],
      },
    });
    await Bun.sleep(5);
    expect(notifications).toHaveLength(0);

    broker.online = true;
    await waitForNotifications(notifications, 1, 1_000);

    expect(notifications[0]).toMatchObject({
      eventId: "evt_question",
      route: { sessionId: "ses_root" },
      kind: "question.pending",
    });
  });
});

class FakeRouteClient {
  readonly routes: RouteIntent[] = [];
  readonly #active = new Map<string, RouteKey>();
  online = true;

  async upsertRoute(intent: RouteIntent): Promise<RouteKey> {
    const index = this.routes.findIndex(
      (item) => item.projectId === intent.projectId && item.sessionId === intent.sessionId,
    );
    if (index >= 0) this.routes[index] = intent;
    else this.routes.push(intent);
    const route = {
      machineId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      projectId: intent.projectId,
      sessionId: intent.sessionId,
      routeGeneration: crypto.randomUUID(),
    };
    this.#active.set(key(intent.projectId, intent.sessionId), route);
    return route;
  }

  async removeRoute(projectId: string, sessionId: string): Promise<void> {
    const index = this.routes.findIndex(
      (item) => item.projectId === projectId && item.sessionId === sessionId,
    );
    if (index >= 0) this.routes.splice(index, 1);
    this.#active.delete(key(projectId, sessionId));
  }

  activeRoute(projectId: string, sessionId: string): RouteKey | undefined {
    if (!this.online) return undefined;
    return this.#active.get(key(projectId, sessionId));
  }
}

function sessionCreated(sessionId: string, title: string, parentID?: string) {
  return {
    type: "session.created",
    properties: { info: { id: sessionId, title, ...(parentID ? { parentID } : {}) } },
  };
}

function key(projectId: string, sessionId: string): string {
  return `${projectId}:${sessionId}`;
}

async function waitForNotifications(
  notifications: NormalizedNotification[],
  count: number,
  timeoutMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (notifications.length < count && Date.now() < deadline) await Bun.sleep(1);
}
