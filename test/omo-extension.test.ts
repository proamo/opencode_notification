import { describe, expect, test } from "bun:test";
import {
  createOmoExtension,
  type OmoContext,
  type OmoEntry,
  type OmoExtensionApi,
  type OmoGateway,
  resolveSettledOutcome,
} from "../src/omo/extension";
import type { NormalizedNotification, RouteKey } from "../src/protocol";
import { RouteKeySchema } from "../src/protocol";

const ROUTE: RouteKey = RouteKeySchema.parse({
  machineId: "11111111-1111-4111-8111-111111111111",
  instanceId: "22222222-2222-4222-8222-222222222222",
  projectId: "project-id-0123456789",
  sessionId: "omo-session",
  routeGeneration: "33333333-3333-4333-8333-333333333333",
});

function assistant(message: Record<string, unknown>): OmoEntry {
  return { type: "message", message: { role: "assistant", ...message } };
}

function harness(options: {
  entries: OmoEntry[];
  sessionKind?: "interactive" | "worker";
  spawnedBy?: unknown;
  notifyCompletion?: boolean;
}) {
  const published: NormalizedNotification[] = [];
  let connects = 0;
  const gateway: OmoGateway = {
    projectId: ROUTE.projectId,
    projectLabel: "demo",
    hostLabel: "codeCenter",
    locale: "zh-TW",
    notifyCompletion: options.notifyCompletion ?? true,
    notifyError: true,
    broker: {
      upsertRoute: async () => ROUTE,
      publishNotification: async (notification) => {
        published.push(notification);
        return "queued";
      },
    },
  };
  let handler: ((event: unknown, ctx: OmoContext) => Promise<void>) | undefined;
  const pi: OmoExtensionApi = {
    ...(options.sessionKind ? { sessionKind: options.sessionKind } : {}),
    on: (_event, registered) => {
      handler = registered;
    },
  };
  const diagnostics: string[] = [];
  createOmoExtension(
    async () => {
      connects += 1;
      return gateway;
    },
    (message) => diagnostics.push(message),
  )(pi);
  const ctx: OmoContext = {
    cwd: "/tmp/demo",
    sessionManager: {
      getSessionId: () => "omo-session",
      getSessionName: () => "Fix login",
      getHeader: () => (options.spawnedBy ? { spawnedBy: options.spawnedBy } : {}),
      getBranch: () => options.entries,
      getLeafId: () => "leaf-1",
    },
  };
  return {
    settle: async () => handler?.({}, ctx),
    published,
    diagnostics,
    connects: () => connects,
    registered: () => handler !== undefined,
  };
}

describe("resolveSettledOutcome", () => {
  test("uses the last assistant message text as the completion summary", () => {
    const outcome = resolveSettledOutcome([
      assistant({ stopReason: "stop", content: [{ type: "text", text: "old" }] }),
      { type: "message", message: { role: "user", content: "next" } },
      assistant({
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "<think>x</think>Done." },
        ],
      }),
      { type: "custom" },
    ]);
    expect(outcome).toEqual({ kind: "session.completed", summary: "Done." });
  });

  test("maps a final provider error to a session error category", () => {
    expect(
      resolveSettledOutcome([assistant({ stopReason: "error", errorMessage: "429 rate limit" })]),
    ).toEqual({ kind: "session.error", errorCategory: "rate_limit" });
  });

  test("ignores user-aborted runs and sessions without an assistant reply", () => {
    expect(resolveSettledOutcome([assistant({ stopReason: "aborted" })])).toBeUndefined();
    expect(resolveSettledOutcome([])).toBeUndefined();
  });

  test("truncates long summaries", () => {
    const outcome = resolveSettledOutcome([
      assistant({ stopReason: "stop", content: [{ type: "text", text: "a".repeat(700) }] }),
    ]);
    expect(outcome?.kind === "session.completed" && outcome.summary?.length).toBe(600);
  });
});

describe("createOmoExtension", () => {
  test("publishes one completion notification for a settled interactive root session", async () => {
    const run = harness({
      entries: [assistant({ stopReason: "stop", content: [{ type: "text", text: "All set" }] })],
    });
    await run.settle();
    expect(run.published).toHaveLength(1);
    expect(run.published[0]).toMatchObject({
      kind: "session.completed",
      eventId: "omo:omo-session:leaf-1",
      route: ROUTE,
      locale: "zh-TW",
      hostLabel: "codeCenter",
      projectLabel: "demo",
      sessionLabel: "OMO: Fix login",
      summary: "All set",
    });
  });

  test("does not register for worker sessions", () => {
    expect(harness({ entries: [], sessionKind: "worker" }).registered()).toBe(false);
  });

  test("skips execution children without connecting to the Gateway", async () => {
    const run = harness({
      entries: [assistant({ stopReason: "stop", content: [{ type: "text", text: "child" }] })],
      spawnedBy: { parentSessionId: "root" },
    });
    await run.settle();
    expect(run.published).toHaveLength(0);
    expect(run.connects()).toBe(0);
  });

  test("honors the completion notification filter", async () => {
    const run = harness({
      entries: [assistant({ stopReason: "stop", content: [{ type: "text", text: "x" }] })],
      notifyCompletion: false,
    });
    await run.settle();
    expect(run.published).toHaveLength(0);
  });
});
