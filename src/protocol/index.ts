import { z } from "zod";

export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
export const MAX_FRAME_BYTES = 256 * 1024;
export const BROKER_CAPABILITIES = [
  "route-registration",
  "heartbeat",
  "notification-publish",
] as const;
export const ConfigFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TelegramBotTokenSchema = z
  .string()
  .regex(/^\d+:[A-Za-z0-9_-]{20,}$/, "Telegram bot token format is invalid");
const TelegramIdSchema = z.string().regex(/^[1-9]\d*$/);

export const ProtocolVersionSchema = z.object({
  major: z.literal(PROTOCOL_VERSION.major),
  minor: z.number().int().nonnegative(),
});

export const TelegramRuntimeConfigSchema = z.object({
  botToken: TelegramBotTokenSchema,
  userId: TelegramIdSchema,
  chatId: TelegramIdSchema,
  locale: z.enum(["en", "zh-TW"]),
  sessionPromptTtlMinutes: z
    .number()
    .int()
    .min(1)
    .max(365 * 24 * 60),
  questionTtlMinutes: z
    .number()
    .int()
    .min(1)
    .max(365 * 24 * 60),
  voiceApiKey: z.string().min(1).optional(),
  voiceAccountId: z.string().min(1).optional(),
  voiceProvider: z.enum(["groq", "openai", "cloudflare", "custom"]).optional(),
  voiceModel: z.string().min(1).optional(),
});
export type TelegramRuntimeConfig = z.infer<typeof TelegramRuntimeConfigSchema>;

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
    hostLabel: z.string().min(1).max(128).optional(),
    projectLabel: z.string().min(1).max(128).optional(),
    configFingerprint: ConfigFingerprintSchema,
    capabilities: z.array(z.string().min(1).max(64)).max(64),
    telegram: TelegramRuntimeConfigSchema.optional(),
  }),
});

export const RouteRegisterEnvelopeSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("route.register"),
  payload: z.object({
    route: RouteKeySchema,
    hostLabel: z.string().min(1).max(128).optional(),
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
      .array(z.array(z.string().min(1).max(2048)).min(1).max(20))
      .min(1)
      .max(20),
  }),
  z.object({
    type: z.literal("permission.reply"),
    commandId: z.uuid(),
    route: RouteKeySchema,
    interactionId: z.string().min(1).max(256),
    response: z.enum(["once", "always", "reject"]),
  }),
  z.object({
    type: z.literal("session.cancel"),
    commandId: z.uuid(),
    route: RouteKeySchema,
    reason: z.string().min(1).max(256).optional(),
  }),
  z.object({
    type: z.literal("session.spawn"),
    commandId: z.uuid(),
    instanceId: z.uuid().optional(),
    title: z.string().min(1).max(256).optional(),
    prompt: z.string().min(1).max(16_384),
  }),
]);
export type BrokerCommand = z.infer<typeof BrokerCommandSchema>;

export const CommandResultSchema = z.object({
  commandId: z.uuid(),
  status: z.enum(["accepted", "rejected", "stale", "indeterminate"]),
  reason: z.string().min(1).max(256).optional(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const CommandResultEnvelopeSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("command.result"),
  payload: CommandResultSchema,
});

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
    type: z.literal("notification.published"),
    payload: z.object({
      eventId: z.string().min(1).max(256),
      status: z.enum(["queued", "duplicate"]),
    }),
  }),
  z.object({
    ...EnvelopeFields,
    type: z.literal("heartbeat.ack"),
    payload: z.object({}),
  }),
  z.object({
    ...EnvelopeFields,
    type: z.literal("command"),
    payload: BrokerCommandSchema,
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
  hostLabel: z.string().min(1).max(128).optional(),
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
  NotificationBaseSchema.extend({
    kind: z.literal("session.completed"),
    summary: z.string().max(4096).optional(),
  }),
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

export const NotificationPublishEnvelopeSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("notification.publish"),
  payload: z.object({ notification: NormalizedNotificationSchema }),
});

export const ClientEnvelopeSchema = z.discriminatedUnion("type", [
  RegisterEnvelopeSchema,
  RouteRegisterEnvelopeSchema,
  RouteUnregisterEnvelopeSchema,
  NotificationPublishEnvelopeSchema,
  HeartbeatEnvelopeSchema,
  CommandResultEnvelopeSchema,
]);
export type ClientEnvelope = z.infer<typeof ClientEnvelopeSchema>;

export const DiagnosticSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1).max(512),
  details: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
