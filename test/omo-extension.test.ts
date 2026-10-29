import { describe, expect, test } from "bun:test";
import {
  createOmoExtension,
  normalizeAskUserRequest,
  type OmoContext,
  type OmoEntry,
  type OmoExtensionApi,
  type OmoGateway,
  resolveSettledOutcome,
  type UiPromptEvent,
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
  notifyQuestion?: boolean;
  idle?: boolean;
}) {
  const published: NormalizedNotification[] = [];
  const settled = Promise.withResolvers<void>();
  let connects = 0;
  const gateway: OmoGateway = {
    projectId: ROUTE.projectId,
    projectLabel: "demo",
    hostLabel: "codeCenter",
    locale: "zh-TW",
    notifyCompletion: options.notifyCompletion ?? true,
    notifyError: true,
    notifyQuestion: options.notifyQuestion ?? true,
    broker: {
      upsertRoute: async () => ROUTE,
      publishNotification: async (notification) => {
        published.push(notification);
        settled.resolve();
        return "queued";
      },
    },
  };
  const handlers = new Map<string, (event: never, ctx: OmoContext) => Promise<void>>();
  let askUser: ((data: { ctx?: OmoContext; request?: unknown }) => void) | undefined;
  const pi: OmoExtensionApi = {
    ...(options.sessionKind ? { sessionKind: options.sessionKind } : {}),
    on: (event: string, registered: (event: never, ctx: OmoContext) => Promise<void>) => {
      handlers.set(event, registered);
    },
    events: {
      on: (_channel, registered) => {
        askUser = registered;
      },
    },
  };
  const diagnostics: string[] = [];
  createOmoExtension(
    async () => {
      connects += 1;
      return gateway;
    },
    (message) => {
      diagnostics.push(message);
      settled.resolve();
    },
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
    isIdle: () => options.idle ?? false,
  };
  return {
    settle: async () => handlers.get("agent_settled")?.({} as never, ctx),
    uiPrompt: async (event: UiPromptEvent) =>
      handlers.get("ui_prompt_start")?.(event as never, ctx),
    askUser: async (request: unknown) => {
      askUser?.({ ctx, request });
      await settled.promise;
    },
    published,
    diagnostics,
    connects: () => connects,
    registered: () => handlers.size > 0,
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

  test("rejects malformed ask_user requests", () => {
    expect(normalizeAskUserRequest(undefined)).toBeUndefined();
    expect(normalizeAskUserRequest({ requestId: "r", questions: [{}] })).toBeUndefined();
    expect(normalizeAskUserRequest({ questions: [{ question: "q" }] })).toBeUndefined();
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

  test("publishes an ask_user question with its options as a pending question", async () => {
    const run = harness({ entries: [] });
    await run.askUser({
      requestId: "toolu_1|item_2",
      questions: [
        {
          id: "q1",
          header: "Color",
          question: "Pick a color",
          options: [{ label: "red" }, { label: "blue", description: "cool" }],
          multiSelect: false,
        },
      ],
    });
    expect(run.published).toHaveLength(1);
    expect(run.published[0]).toMatchObject({
      kind: "question.pending",
      eventId: "omo:ask:toolu_1|item_2",
      interactionId: "toolu_1|item_2",
      questions: [
        {
          header: "Color",
          question: "Pick a color",
          options: [
            { label: "red", description: "" },
            { label: "blue", description: "cool" },
          ],
          multiple: false,
        },
      ],
    });
  });

  test("notifies agent-initiated dialogs but not question dialogs or idle user commands", async () => {
    const busy = harness({ entries: [] });
    await busy.uiPrompt({ kind: "question", title: "Color" });
    expect(busy.published).toHaveLength(0);
    await busy.uiPrompt({ kind: "confirm", title: "Delete files?" });
    expect(busy.published[0]).toMatchObject({
      kind: "question.pending",
      questions: [{ header: "confirm", question: "Delete files?", options: [] }],
    });

    const idle = harness({ entries: [], idle: true });
    await idle.uiPrompt({ kind: "select", title: "Pick a model" });
    expect(idle.published).toHaveLength(0);
  });

  test("honors the question notification filter", async () => {
    const run = harness({ entries: [], notifyQuestion: false });
    await run.uiPrompt({ kind: "confirm", title: "Continue?" });
    expect(run.published).toHaveLength(0);
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
