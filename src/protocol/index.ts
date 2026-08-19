import { z } from "zod";

export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
export const MAX_FRAME_BYTES = 256 * 1024;
export const BROKER_CAPABILITIES = ["route-registration", "heartbeat"] as const;

export const ProtocolVersionSchema = z.object({
  major: z.literal(PROTOCOL_VERSION.major),
  minor: z.number().int().nonnegative(),
});

export const RouteKeySchema = z.object({
  machineId: z.uuid(),
  instanceId: z.uuid(),
  projectId: z.string().min(16).max(128),
  sessionId: z.string().min(1).max(256),
  routeGeneration: z.uuid(),
});
export type RouteKey = z.infer<typeof RouteKeySchema>;

const EnvelopeFields = {
  protocol: ProtocolVersionSchema,
  requestId: z.uuid(),
  sentAt: z.iso.datetime({ offset: true }),
};

export const RegisterEnvelopeSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("register"),
  payload: z.object({
    packageVersion: z.string().min(1).max(64),
    openCodeVersion: z.string().min(1).max(64),
    machineId: z.uuid(),
    instanceId: z.uuid(),
    capabilities: z.array(z.string().min(1).max(64)).max(64),
  }),
});

export const RouteRegisterEnvelopeSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("route.register"),
  payload: z.object({
    route: RouteKeySchema,
    projectLabel: z.string().min(1).max(128),
    sessionLabel: z.string().min(1).max(256),
  }),
});

export const RouteUnregisterEnvelopeSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("route.unregister"),
  payload: z.object({ route: RouteKeySchema }),
});

export const HeartbeatEnvelopeSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("heartbeat"),
  payload: z.object({}),
});

export const ClientEnvelopeSchema = z.discriminatedUnion("type", [
  RegisterEnvelopeSchema,
  RouteRegisterEnvelopeSchema,
  RouteUnregisterEnvelopeSchema,
  HeartbeatEnvelopeSchema,
]);
export type ClientEnvelope = z.infer<typeof ClientEnvelopeSchema>;

export const BrokerEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({
    ...EnvelopeFields,
    type: z.literal("registered"),
    payload: z.object({
      machineId: z.uuid(),
      capabilities: z.array(z.string().min(1).max(64)).max(64),
    }),
  }),
  z.object({
    ...EnvelopeFields,
    type: z.literal("route.registered"),
    payload: z.object({ route: RouteKeySchema }),
  }),
  z.object({
    ...EnvelopeFields,
    type: z.literal("route.unregistered"),
    payload: z.object({ route: RouteKeySchema }),
  }),
  z.object({
    ...EnvelopeFields,
    type: z.literal("heartbeat.ack"),
    payload: z.object({}),
  }),
  z.object({
    ...EnvelopeFields,
    type: z.literal("error"),
    payload: z.object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      message: z.string().min(1).max(256),
    }),
  }),
]);
export type BrokerEnvelope = z.infer<typeof BrokerEnvelopeSchema>;

const NotificationBaseSchema = z.object({
  eventId: z.string().min(1).max(256),
  route: RouteKeySchema,
  locale: z.enum(["en", "zh-TW"]),
  projectLabel: z.string().min(1).max(128),
  sessionLabel: z.string().min(1).max(256),
  rootSessionLabel: z.string().min(1).max(256).optional(),
  occurredAt: z.iso.datetime({ offset: true }),
});

export const NormalizedQuestionSchema = z.object({
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
  multiple: z.boolean(),
  custom: z.boolean(),
});
export type NormalizedQuestion = z.infer<typeof NormalizedQuestionSchema>;

export const NormalizedNotificationSchema = z.discriminatedUnion("kind", [
  NotificationBaseSchema.extend({ kind: z.literal("session.completed") }),
  NotificationBaseSchema.extend({
    kind: z.literal("session.error"),
    errorCategory: z.string().min(1).max(64),
  }),
  NotificationBaseSchema.extend({
    kind: z.literal("question.pending"),
    interactionId: z.string().min(1).max(256),
    questions: z.array(NormalizedQuestionSchema).min(1).max(20),
  }),
  NotificationBaseSchema.extend({
    kind: z.literal("permission.pending"),
    interactionId: z.string().min(1).max(256),
    permissionCategory: z.string().min(1).max(64),
  }),
]);
export type NormalizedNotification = z.infer<typeof NormalizedNotificationSchema>;

export const BrokerCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.prompt"),
    commandId: z.uuid(),
    route: RouteKeySchema,
    text: z.string().min(1).max(16_384),
  }),
  z.object({
    type: z.literal("question.reply"),
    commandId: z.uuid(),
    route: RouteKeySchema,
    interactionId: z.string().min(1).max(256),
    answers: z
      .array(z.array(z.string().max(2048)).max(20))
      .min(1)
      .max(20),
  }),
]);
export type BrokerCommand = z.infer<typeof BrokerCommandSchema>;

export const CommandResultSchema = z.object({
  commandId: z.uuid(),
  status: z.enum(["accepted", "rejected", "stale", "indeterminate"]),
  reason: z.string().min(1).max(256).optional(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const DiagnosticSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1).max(512),
  details: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
