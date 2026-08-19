import { describe, expect, test } from "bun:test";
import {
  BrokerCommandSchema,
  BrokerEnvelopeSchema,
  ClientEnvelopeSchema,
  NormalizedNotificationSchema,
  PROTOCOL_VERSION,
  RegisterEnvelopeSchema,
  RouteKeySchema,
} from "../src/protocol";

const route = {
  machineId: crypto.randomUUID(),
  instanceId: crypto.randomUUID(),
  projectId: "opaque-project-id-value",
  sessionId: "ses_123",
  routeGeneration: crypto.randomUUID(),
};

describe("protocol schemas", () => {
  test("accepts a complete composite route", () => {
    expect(RouteKeySchema.parse(route)).toEqual(route);
  });

  test("rejects a partial route", () => {
    const { sessionId: _, ...partialRoute } = route;
    expect(RouteKeySchema.safeParse(partialRoute).success).toBe(false);
  });

  test("validates registration envelopes", () => {
    const result = RegisterEnvelopeSchema.safeParse({
      protocol: PROTOCOL_VERSION,
      type: "register",
      requestId: crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      payload: {
        packageVersion: "0.0.0",
        openCodeVersion: "1.18.18",
        machineId: route.machineId,
        instanceId: route.instanceId,
        configFingerprint: "a".repeat(64),
        capabilities: ["notifications"],
      },
    });

    expect(result.success).toBe(true);
  });

  test("keeps session prompts and question replies distinct", () => {
    expect(
      BrokerCommandSchema.safeParse({
        type: "session.prompt",
        commandId: crypto.randomUUID(),
        route,
        text: "Continue with the tests",
      }).success,
    ).toBe(true);

    expect(
      BrokerCommandSchema.safeParse({
        type: "question.reply",
        commandId: crypto.randomUUID(),
        route,
        interactionId: "question_1",
        answers: [["Option A"]],
      }).success,
    ).toBe(true);

    expect(
      BrokerCommandSchema.safeParse({
        type: "permission.reply",
        commandId: crypto.randomUUID(),
        route,
        interactionId: "permission_1",
        answer: "allow",
      }).success,
    ).toBe(false);
  });

  test("validates broker command and client command-result envelopes", () => {
    const commandId = crypto.randomUUID();
    const requestId = crypto.randomUUID();

    expect(
      BrokerEnvelopeSchema.safeParse({
        protocol: PROTOCOL_VERSION,
        type: "command",
        requestId,
        sentAt: new Date().toISOString(),
        payload: {
          type: "session.prompt",
          commandId,
          route,
          text: "Continue with the tests",
        },
      }).success,
    ).toBe(true);

    expect(
      ClientEnvelopeSchema.safeParse({
        protocol: PROTOCOL_VERSION,
        type: "command.result",
        requestId,
        sentAt: new Date().toISOString(),
        payload: { commandId, status: "accepted" },
      }).success,
    ).toBe(true);
  });

  test("accepts only allowlisted notification kinds", () => {
    expect(
      NormalizedNotificationSchema.safeParse({
        kind: "session.completed",
        eventId: "event_1",
        route,
        locale: "zh-TW",
        projectLabel: "backend-api",
        sessionLabel: "Implement authentication",
        occurredAt: new Date().toISOString(),
      }).success,
    ).toBe(true);

    expect(
      NormalizedNotificationSchema.safeParse({
        kind: "tool.output",
        eventId: "event_2",
        route,
        locale: "en",
        projectLabel: "backend-api",
        sessionLabel: "Implement authentication",
        occurredAt: new Date().toISOString(),
        output: "secret output",
      }).success,
    ).toBe(false);
  });
});
