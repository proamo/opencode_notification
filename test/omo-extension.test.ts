import { describe, expect, test } from "bun:test";
import {
  createOmoExtension,
  handleOmoCommand,
  normalizeAskUserRequest,
  type OmoContext,
  type OmoEntry,
  type OmoExtensionApi,
  type OmoGateway,
  type OmoQuestionTarget,
  type OmoSessionInbox,
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
  let registrations = 0;
  const activity: boolean[] = [];
  const interrupted: string[] = [];
  const gateway: OmoGateway = {
    projectId: ROUTE.projectId,
    projectLabel: "demo",
    hostLabel: "codeCenter",
    locale: "zh-TW",
    notifyCompletion: options.notifyCompletion ?? true,
    notifyError: true,
    notifyQuestion: options.notifyQuestion ?? true,
    broker: {
      activeRoute: () => (registrations > 0 ? ROUTE : undefined),
      upsertRoute: async (intent) => {
        registrations += 1;
        activity.push(intent.active ?? true);
        return ROUTE;
      },
      setRouteActivity: async (_projectId, _sessionId, active) => {
        activity.push(active);
        return true;
      },
      publishNotification: async (notification) => {
        published.push(notification);
        settled.resolve();
        return "queued";
      },
    },
  };
  const handlers = new Map<string, (event: never, ctx: OmoContext) => Promise<void> | void>();
  const sent: Array<{ text: string; options: unknown }> = [];
  const inbox: OmoSessionInbox = new Map();
  const questions = new Map<string, OmoQuestionTarget>();
  const answered: Array<{ sessionId: string; requestId: string; answers: unknown }> = [];
  const busHandlers = new Map<string, (data: never) => void>();
  const pi: OmoExtensionApi = {
    ...(options.sessionKind ? { sessionKind: options.sessionKind } : {}),
    on: (event: string, registered: (event: never, ctx: OmoContext) => Promise<void> | void) => {
      handlers.set(event, registered);
    },
    sendUserMessage: (text, sendOptions) => {
      sent.push({ text, options: sendOptions });
    },
    events: {
      on: (channel: string, registered: (data: never) => void) => {
        busHandlers.set(channel, registered);
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
    inbox,
    questions,
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
      busHandlers.get("ask-user:asked")?.({ ctx, request } as never);
      await settled.promise;
    },
    closeQuestion: (requestId: string) =>
      busHandlers.get("ask-user:closed")?.({ requestId, status: "answered" } as never),
    targets: {
      inbox,
      questions,
      answerQuestion: async (sessionId: string, requestId: string, answers: unknown) => {
        answered.push({ sessionId, requestId, answers });
      },
      interrupt: async (sessionId: string) => {
        interrupted.push(sessionId);
        return true;
      },
    },
    agentStart: () => handlers.get("agent_start")?.({} as never, ctx),
    activity,
    interrupted,
    answered,
    questions,
    start: () => handlers.get("session_start")?.({} as never, ctx),
    shutdown: () => handlers.get("session_shutdown")?.({} as never, ctx),
    inbox,
    sent,
    published,
    diagnostics,
    connects: () => connects,
    registrations: () => registrations,
    registered: () => handlers.size > 0,
  };
}

function prompt(text: string) {
  return {
    type: "session.prompt" as const,
    commandId: "44444444-4444-4444-8444-444444444444",
    route: ROUTE,
    text,
  };
}

describe("Telegram replies to OMO sessions", () => {
  test("delivers a reply to the open session as a follow-up user message", async () => {
    const run = harness({ entries: [] });
    await run.start();
    expect(await handleOmoCommand(prompt("continue please"), run.targets)).toEqual({
      commandId: "44444444-4444-4444-8444-444444444444",
      status: "accepted",
    });
    expect(run.sent).toEqual([{ text: "continue please", options: { deliverAs: "followUp" } }]);
  });

  test("rejects replies after the session shuts down", async () => {
    const run = harness({ entries: [] });
    await run.start();
    await run.shutdown();
    expect(await handleOmoCommand(prompt("hello"), run.targets)).toMatchObject({
      status: "rejected",
      reason: "OMO session is not open",
    });
    expect(run.sent).toHaveLength(0);
  });

  test("does not accept replies for execution children", async () => {
    const run = harness({ entries: [], spawnedBy: { parentSessionId: "root" } });
    await run.start();
    expect(run.inbox.size).toBe(0);
  });

  test("interrupts the running session for a Telegram cancel", async () => {
    const run = harness({ entries: [] });
    const cancel = {
      type: "session.cancel" as const,
      commandId: "44444444-4444-4444-8444-444444444444",
      route: ROUTE,
    };
    expect(await handleOmoCommand(cancel, run.targets)).toMatchObject({ status: "accepted" });
    expect(run.interrupted).toEqual(["omo-session"]);
    const idle = await handleOmoCommand(cancel, { ...run.targets, interrupt: async () => false });
    expect(idle).toMatchObject({ status: "rejected", reason: "OMO session is idle" });
  });

  test("marks the session active while OMO works and inactive once it settles", async () => {
    const run = harness({
      entries: [assistant({ stopReason: "stop", content: [{ type: "text", text: "done" }] })],
    });
    await run.agentStart();
    await run.settle();
    expect(run.activity).toEqual([true, false]);
    expect(run.registrations()).toBe(1);
  });

  test("rejects commands OMO cannot run", async () => {
    const run = harness({ entries: [] });
    await run.start();
    const result = await handleOmoCommand(
      {
        type: "session.spawn",
        commandId: "44444444-4444-4444-8444-444444444444",
        prompt: "new work",
      },
      run.targets,
    );
    expect(result).toMatchObject({ status: "rejected" });
    expect(run.sent).toHaveLength(0);
  });
});

const COLOR_QUESTION = {
  requestId: "toolu_1|item_2",
  waitForAnswer: false,
  questions: [
    {
      id: "q1",
      header: "Color",
      question: "Pick a color",
      options: [{ label: "red" }, { label: "blue" }],
      multiSelect: false,
    },
  ],
};

function questionReply(answers: string[][], interactionId = COLOR_QUESTION.requestId) {
  return {
    type: "question.reply" as const,
    commandId: "44444444-4444-4444-8444-444444444444",
    route: ROUTE,
    interactionId,
    answers,
  };
}

describe("Telegram answers to OMO questions", () => {
  test("asks for a terminal answer when OMO shows a blocking question", async () => {
    const run = harness({ entries: [] });
    await run.askUser({ ...COLOR_QUESTION, waitForAnswer: true });
    expect(await handleOmoCommand(questionReply([["red"]]), run.targets)).toMatchObject({
      status: "rejected",
      reason: "terminal intervention required",
    });
    expect(run.answered).toHaveLength(0);
  });

  test("answers a pending question with the selected option by question id", async () => {
    const run = harness({ entries: [] });
    await run.askUser(COLOR_QUESTION);
    const result = await handleOmoCommand(questionReply([["blue"]]), run.targets);
    expect(result.status).toBe("accepted");
    expect(run.answered).toEqual([
      {
        sessionId: "omo-session",
        requestId: "toolu_1|item_2",
        answers: { q1: { selected: ["blue"] } },
      },
    ]);
    expect(run.questions.size).toBe(0);
  });

  test("keeps one route per session so earlier question buttons stay valid", async () => {
    const run = harness({
      entries: [assistant({ stopReason: "stop", content: [{ type: "text", text: "asked" }] })],
    });
    await run.askUser(COLOR_QUESTION);
    await run.settle();
    expect(run.published.map((notification) => notification.kind)).toEqual([
      "question.pending",
      "session.completed",
    ]);
    expect(run.registrations()).toBe(1);
  });

  test("sends typed text that matches no option as a free-form answer", async () => {
    const run = harness({ entries: [] });
    await run.askUser(COLOR_QUESTION);
    await handleOmoCommand(questionReply([["green please"]]), run.targets);
    expect(run.answered[0]?.answers).toEqual({ q1: { selected: [], text: "green please" } });
  });

  test("reports closed or unknown questions as stale", async () => {
    const run = harness({ entries: [] });
    await run.askUser(COLOR_QUESTION);
    run.closeQuestion(COLOR_QUESTION.requestId);
    expect(await handleOmoCommand(questionReply([["red"]]), run.targets)).toMatchObject({
      status: "stale",
    });
    expect(run.answered).toHaveLength(0);
  });

  test("keeps the question pending when the terminal refuses the answer", async () => {
    const run = harness({ entries: [] });
    await run.askUser(COLOR_QUESTION);
    const result = await handleOmoCommand(questionReply([["red"]]), {
      ...run.targets,
      answerQuestion: async () => {
        throw new Error("terminal intervention required");
      },
    });
    expect(result).toMatchObject({ status: "rejected", reason: "terminal intervention required" });
    expect(run.questions.size).toBe(1);
  });
});

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
