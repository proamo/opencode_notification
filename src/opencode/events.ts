import { z } from "zod";
import type { NormalizedQuestion } from "../protocol";

export type SessionSourceEvent = {
  kind: "session.upsert" | "session.delete";
  sessionId: string;
  title: string;
  parentId?: string;
};

export type NotificationSourceEvent =
  | {
      kind: "session.completed";
      sessionId: string;
      sourceEventId?: string;
    }
  | {
      kind: "session.error";
      sessionId: string;
      errorCategory: string;
      sourceEventId?: string;
    }
  | {
      kind: "question.pending";
      sessionId: string;
      interactionId: string;
      questions: NormalizedQuestion[];
      sourceEventId?: string;
    }
  | {
      kind: "permission.pending";
      sessionId: string;
      interactionId: string;
      permissionCategory: string;
      sourceEventId?: string;
    };

export type OpenCodeEventResult =
  | { status: "session"; event: SessionSourceEvent }
  | { status: "notification"; event: NotificationSourceEvent }
  | { status: "ignored" }
  | { status: "invalid"; eventType: string; code: string };

const SessionInfoSchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().min(1).max(512),
  parentID: z.string().min(1).max(256).optional(),
});

const QuestionSchema = z.object({
  question: z.string().min(1).max(4096),
  header: z.string().min(1).max(128),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(256),
        description: z.string().max(2048),
      }),
    )
    .max(20),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
});

const EventIdentitySchema = z.object({ id: z.string().min(1).max(256).optional() });

const knownNotificationTypes = new Set([
  "session.idle",
  "session.error",
  "question.asked",
  "question.v2.asked",
  "permission.updated",
  "permission.asked",
  "permission.v2.asked",
]);

export function normalizeOpenCodeEvent(input: unknown): OpenCodeEventResult {
  const eventType = eventTypeOf(input);
  if (!eventType) return { status: "ignored" };

  if (eventType === "session.created" || eventType === "session.updated") {
    const parsed = z
      .object({ type: z.literal(eventType), properties: z.object({ info: SessionInfoSchema }) })
      .safeParse(input);
    if (!parsed.success) return invalid(eventType);
    const info = parsed.data.properties.info;
    return {
      status: "session",
      event: {
        kind: "session.upsert",
        sessionId: info.id,
        title: info.title,
        ...(info.parentID ? { parentId: info.parentID } : {}),
      },
    };
  }

  if (eventType === "session.deleted") {
    const parsed = z
      .object({
        type: z.literal("session.deleted"),
        properties: z.object({ info: SessionInfoSchema }),
      })
      .safeParse(input);
    if (!parsed.success) return invalid(eventType);
    const info = parsed.data.properties.info;
    return {
      status: "session",
      event: {
        kind: "session.delete",
        sessionId: info.id,
        title: info.title,
        ...(info.parentID ? { parentId: info.parentID } : {}),
      },
    };
  }

  if (eventType === "session.idle") {
    const raw = input as Record<string, unknown> | null;
    const props = (raw?.properties ?? {}) as Record<string, unknown>;
    const sessionId =
      typeof props.sessionID === "string"
        ? props.sessionID
        : typeof props.sessionId === "string"
          ? props.sessionId
          : typeof props.id === "string"
            ? props.id
            : typeof raw?.sessionID === "string"
              ? raw.sessionID
              : typeof raw?.sessionId === "string"
                ? raw.sessionId
                : undefined;
    if (!sessionId || sessionId.length === 0) return invalid(eventType);
    const sourceEventId = typeof raw?.id === "string" ? raw.id : undefined;
    return {
      status: "notification",
      event: {
        kind: "session.completed",
        sessionId,
        ...(sourceEventId ? { sourceEventId } : {}),
      },
    };
  }

  if (eventType === "session.error") return normalizeSessionError(input, eventType);
  if (eventType === "question.asked" || eventType === "question.v2.asked") {
    return normalizeQuestion(input, eventType);
  }
  if (
    eventType === "permission.updated" ||
    eventType === "permission.asked" ||
    eventType === "permission.v2.asked"
  ) {
    return normalizePermission(input, eventType);
  }

  return knownNotificationTypes.has(eventType) ? invalid(eventType) : { status: "ignored" };
}

function normalizeSessionError(input: unknown, eventType: string): OpenCodeEventResult {
  const raw = input as Record<string, unknown> | null;
  const props = (raw?.properties ?? {}) as Record<string, unknown>;
  const sessionId =
    typeof props.sessionID === "string"
      ? props.sessionID
      : typeof props.sessionId === "string"
        ? props.sessionId
        : typeof props.id === "string"
          ? props.id
          : undefined;
  if (!sessionId || sessionId.length === 0) return invalid(eventType);
  const errorObj = props.error as Record<string, unknown> | undefined;
  const errorName = typeof errorObj?.name === "string" ? errorObj.name : undefined;
  const sourceEventId = typeof raw?.id === "string" ? raw.id : undefined;
  return {
    status: "notification",
    event: {
      kind: "session.error",
      sessionId,
      errorCategory: errorCategory(errorName),
      ...(sourceEventId ? { sourceEventId } : {}),
    },
  };
}

function normalizeQuestion(input: unknown, eventType: string): OpenCodeEventResult {
  const parsed = z
    .object({
      ...EventIdentitySchema.shape,
      type: z.enum(["question.asked", "question.v2.asked"]),
      properties: z.object({
        id: z.string().min(1).max(256),
        sessionID: z.string().min(1).max(256),
        questions: z.array(QuestionSchema).min(1).max(20),
      }),
    })
    .safeParse(input);
  if (!parsed.success) return invalid(eventType);
  return {
    status: "notification",
    event: {
      kind: "question.pending",
      sessionId: parsed.data.properties.sessionID,
      interactionId: parsed.data.properties.id,
      questions: parsed.data.properties.questions.map((question) => ({
        question: question.question,
        header: question.header,
        options: question.options,
        multiple: question.multiple ?? false,
        custom: question.custom ?? true,
      })),
      sourceEventId: parsed.data.id ?? parsed.data.properties.id,
    },
  };
}

function normalizePermission(input: unknown, eventType: string): OpenCodeEventResult {
  if (eventType === "permission.updated") {
    const parsed = z
      .object({
        ...EventIdentitySchema.shape,
        type: z.literal("permission.updated"),
        properties: z.object({
          id: z.string().min(1).max(256),
          sessionID: z.string().min(1).max(256),
          type: z.string().min(1).max(128),
        }),
      })
      .safeParse(input);
    if (!parsed.success) return invalid(eventType);
    return permissionResult(
      parsed.data.properties.sessionID,
      parsed.data.properties.id,
      parsed.data.properties.type,
      parsed.data.id,
    );
  }

  const parsed = z
    .object({
      ...EventIdentitySchema.shape,
      type: z.enum(["permission.asked", "permission.v2.asked"]),
      properties: z.object({
        id: z.string().min(1).max(256),
        sessionID: z.string().min(1).max(256),
        permission: z.string().min(1).max(128).optional(),
        action: z.string().min(1).max(128).optional(),
      }),
    })
    .safeParse(input);
  if (!parsed.success) return invalid(eventType);
  const category = parsed.data.properties.permission ?? parsed.data.properties.action;
  if (!category) return invalid(eventType);
  return permissionResult(
    parsed.data.properties.sessionID,
    parsed.data.properties.id,
    category,
    parsed.data.id,
  );
}

function permissionResult(
  sessionId: string,
  interactionId: string,
  permissionCategory: string,
  sourceEventId?: string,
): OpenCodeEventResult {
  return {
    status: "notification",
    event: {
      kind: "permission.pending",
      sessionId,
      interactionId,
      permissionCategory,
      sourceEventId: sourceEventId ?? interactionId,
    },
  };
}

function errorCategory(name: string | undefined): string {
  const categories: Record<string, string> = {
    ProviderAuthError: "provider_auth",
    APIError: "api",
    MessageOutputLengthError: "output_length",
    MessageAbortedError: "aborted",
    ContextOverflowError: "context_overflow",
    ContentFilterError: "content_filter",
    StructuredOutputError: "structured_output",
  };
  return name ? (categories[name] ?? "unknown") : "unknown";
}

function eventTypeOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("type" in input)) return undefined;
  return typeof input.type === "string" ? input.type : undefined;
}

function invalid(eventType: string): OpenCodeEventResult {
  return { status: "invalid", eventType, code: "INCOMPATIBLE_EVENT_PAYLOAD" };
}
