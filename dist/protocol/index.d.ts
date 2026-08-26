import { z } from "zod";
export declare const PROTOCOL_VERSION: {
    readonly major: 1;
    readonly minor: 0;
};
export declare const MAX_FRAME_BYTES: number;
export declare const BROKER_CAPABILITIES: readonly ["route-registration", "heartbeat", "notification-publish"];
export declare const ConfigFingerprintSchema: z.ZodString;
export declare const ProtocolVersionSchema: z.ZodObject<{
    major: z.ZodLiteral<1>;
    minor: z.ZodNumber;
}, z.core.$strip>;
export declare const TelegramRuntimeConfigSchema: z.ZodObject<{
    botToken: z.ZodString;
    userId: z.ZodString;
    chatId: z.ZodString;
    locale: z.ZodEnum<{
        en: "en";
        "zh-TW": "zh-TW";
    }>;
    sessionPromptTtlMinutes: z.ZodNumber;
    questionTtlMinutes: z.ZodNumber;
}, z.core.$strip>;
export type TelegramRuntimeConfig = z.infer<typeof TelegramRuntimeConfigSchema>;
export declare const RouteKeySchema: z.ZodObject<{
    machineId: z.ZodUUID;
    instanceId: z.ZodUUID;
    projectId: z.ZodString;
    sessionId: z.ZodString;
    routeGeneration: z.ZodUUID;
}, z.core.$strip>;
export type RouteKey = z.infer<typeof RouteKeySchema>;
export declare const RegisterEnvelopeSchema: z.ZodObject<{
    type: z.ZodLiteral<"register">;
    payload: z.ZodObject<{
        packageVersion: z.ZodString;
        openCodeVersion: z.ZodString;
        machineId: z.ZodUUID;
        instanceId: z.ZodUUID;
        configFingerprint: z.ZodString;
        capabilities: z.ZodArray<z.ZodString>;
        telegram: z.ZodOptional<z.ZodObject<{
            botToken: z.ZodString;
            userId: z.ZodString;
            chatId: z.ZodString;
            locale: z.ZodEnum<{
                en: "en";
                "zh-TW": "zh-TW";
            }>;
            sessionPromptTtlMinutes: z.ZodNumber;
            questionTtlMinutes: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>;
export declare const RouteRegisterEnvelopeSchema: z.ZodObject<{
    type: z.ZodLiteral<"route.register">;
    payload: z.ZodObject<{
        route: z.ZodObject<{
            machineId: z.ZodUUID;
            instanceId: z.ZodUUID;
            projectId: z.ZodString;
            sessionId: z.ZodString;
            routeGeneration: z.ZodUUID;
        }, z.core.$strip>;
        projectLabel: z.ZodString;
        sessionLabel: z.ZodString;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>;
export declare const RouteUnregisterEnvelopeSchema: z.ZodObject<{
    type: z.ZodLiteral<"route.unregister">;
    payload: z.ZodObject<{
        route: z.ZodObject<{
            machineId: z.ZodUUID;
            instanceId: z.ZodUUID;
            projectId: z.ZodString;
            sessionId: z.ZodString;
            routeGeneration: z.ZodUUID;
        }, z.core.$strip>;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>;
export declare const HeartbeatEnvelopeSchema: z.ZodObject<{
    type: z.ZodLiteral<"heartbeat">;
    payload: z.ZodObject<{}, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>;
export declare const BrokerCommandSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"session.prompt">;
    commandId: z.ZodUUID;
    route: z.ZodObject<{
        machineId: z.ZodUUID;
        instanceId: z.ZodUUID;
        projectId: z.ZodString;
        sessionId: z.ZodString;
        routeGeneration: z.ZodUUID;
    }, z.core.$strip>;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"question.reply">;
    commandId: z.ZodUUID;
    route: z.ZodObject<{
        machineId: z.ZodUUID;
        instanceId: z.ZodUUID;
        projectId: z.ZodString;
        sessionId: z.ZodString;
        routeGeneration: z.ZodUUID;
    }, z.core.$strip>;
    interactionId: z.ZodString;
    answers: z.ZodArray<z.ZodArray<z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"permission.reply">;
    commandId: z.ZodUUID;
    route: z.ZodObject<{
        machineId: z.ZodUUID;
        instanceId: z.ZodUUID;
        projectId: z.ZodString;
        sessionId: z.ZodString;
        routeGeneration: z.ZodUUID;
    }, z.core.$strip>;
    interactionId: z.ZodString;
    response: z.ZodEnum<{
        once: "once";
        always: "always";
        reject: "reject";
    }>;
}, z.core.$strip>], "type">;
export type BrokerCommand = z.infer<typeof BrokerCommandSchema>;
export declare const CommandResultSchema: z.ZodObject<{
    commandId: z.ZodUUID;
    status: z.ZodEnum<{
        accepted: "accepted";
        rejected: "rejected";
        stale: "stale";
        indeterminate: "indeterminate";
    }>;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export declare const CommandResultEnvelopeSchema: z.ZodObject<{
    type: z.ZodLiteral<"command.result">;
    payload: z.ZodObject<{
        commandId: z.ZodUUID;
        status: z.ZodEnum<{
            accepted: "accepted";
            rejected: "rejected";
            stale: "stale";
            indeterminate: "indeterminate";
        }>;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>;
export declare const BrokerEnvelopeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"registered">;
    payload: z.ZodObject<{
        machineId: z.ZodUUID;
        capabilities: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"route.registered">;
    payload: z.ZodObject<{
        route: z.ZodObject<{
            machineId: z.ZodUUID;
            instanceId: z.ZodUUID;
            projectId: z.ZodString;
            sessionId: z.ZodString;
            routeGeneration: z.ZodUUID;
        }, z.core.$strip>;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"route.unregistered">;
    payload: z.ZodObject<{
        route: z.ZodObject<{
            machineId: z.ZodUUID;
            instanceId: z.ZodUUID;
            projectId: z.ZodString;
            sessionId: z.ZodString;
            routeGeneration: z.ZodUUID;
        }, z.core.$strip>;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"notification.published">;
    payload: z.ZodObject<{
        eventId: z.ZodString;
        status: z.ZodEnum<{
            queued: "queued";
            duplicate: "duplicate";
        }>;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"heartbeat.ack">;
    payload: z.ZodObject<{}, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"command">;
    payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"session.prompt">;
        commandId: z.ZodUUID;
        route: z.ZodObject<{
            machineId: z.ZodUUID;
            instanceId: z.ZodUUID;
            projectId: z.ZodString;
            sessionId: z.ZodString;
            routeGeneration: z.ZodUUID;
        }, z.core.$strip>;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"question.reply">;
        commandId: z.ZodUUID;
        route: z.ZodObject<{
            machineId: z.ZodUUID;
            instanceId: z.ZodUUID;
            projectId: z.ZodString;
            sessionId: z.ZodString;
            routeGeneration: z.ZodUUID;
        }, z.core.$strip>;
        interactionId: z.ZodString;
        answers: z.ZodArray<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"permission.reply">;
        commandId: z.ZodUUID;
        route: z.ZodObject<{
            machineId: z.ZodUUID;
            instanceId: z.ZodUUID;
            projectId: z.ZodString;
            sessionId: z.ZodString;
            routeGeneration: z.ZodUUID;
        }, z.core.$strip>;
        interactionId: z.ZodString;
        response: z.ZodEnum<{
            once: "once";
            always: "always";
            reject: "reject";
        }>;
    }, z.core.$strip>], "type">;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"error">;
    payload: z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>], "type">;
export type BrokerEnvelope = z.infer<typeof BrokerEnvelopeSchema>;
export declare const NormalizedQuestionSchema: z.ZodObject<{
    question: z.ZodString;
    header: z.ZodString;
    options: z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        description: z.ZodString;
    }, z.core.$strip>>;
    multiple: z.ZodBoolean;
    custom: z.ZodBoolean;
}, z.core.$strip>;
export type NormalizedQuestion = z.infer<typeof NormalizedQuestionSchema>;
export declare const NormalizedNotificationSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    eventId: z.ZodString;
    route: z.ZodObject<{
        machineId: z.ZodUUID;
        instanceId: z.ZodUUID;
        projectId: z.ZodString;
        sessionId: z.ZodString;
        routeGeneration: z.ZodUUID;
    }, z.core.$strip>;
    locale: z.ZodEnum<{
        en: "en";
        "zh-TW": "zh-TW";
    }>;
    projectLabel: z.ZodString;
    sessionLabel: z.ZodString;
    rootSessionLabel: z.ZodOptional<z.ZodString>;
    occurredAt: z.ZodISODateTime;
    kind: z.ZodLiteral<"session.completed">;
    summary: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    eventId: z.ZodString;
    route: z.ZodObject<{
        machineId: z.ZodUUID;
        instanceId: z.ZodUUID;
        projectId: z.ZodString;
        sessionId: z.ZodString;
        routeGeneration: z.ZodUUID;
    }, z.core.$strip>;
    locale: z.ZodEnum<{
        en: "en";
        "zh-TW": "zh-TW";
    }>;
    projectLabel: z.ZodString;
    sessionLabel: z.ZodString;
    rootSessionLabel: z.ZodOptional<z.ZodString>;
    occurredAt: z.ZodISODateTime;
    kind: z.ZodLiteral<"session.error">;
    errorCategory: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    eventId: z.ZodString;
    route: z.ZodObject<{
        machineId: z.ZodUUID;
        instanceId: z.ZodUUID;
        projectId: z.ZodString;
        sessionId: z.ZodString;
        routeGeneration: z.ZodUUID;
    }, z.core.$strip>;
    locale: z.ZodEnum<{
        en: "en";
        "zh-TW": "zh-TW";
    }>;
    projectLabel: z.ZodString;
    sessionLabel: z.ZodString;
    rootSessionLabel: z.ZodOptional<z.ZodString>;
    occurredAt: z.ZodISODateTime;
    kind: z.ZodLiteral<"question.pending">;
    interactionId: z.ZodString;
    questions: z.ZodArray<z.ZodObject<{
        question: z.ZodString;
        header: z.ZodString;
        options: z.ZodArray<z.ZodObject<{
            label: z.ZodString;
            description: z.ZodString;
        }, z.core.$strip>>;
        multiple: z.ZodBoolean;
        custom: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    eventId: z.ZodString;
    route: z.ZodObject<{
        machineId: z.ZodUUID;
        instanceId: z.ZodUUID;
        projectId: z.ZodString;
        sessionId: z.ZodString;
        routeGeneration: z.ZodUUID;
    }, z.core.$strip>;
    locale: z.ZodEnum<{
        en: "en";
        "zh-TW": "zh-TW";
    }>;
    projectLabel: z.ZodString;
    sessionLabel: z.ZodString;
    rootSessionLabel: z.ZodOptional<z.ZodString>;
    occurredAt: z.ZodISODateTime;
    kind: z.ZodLiteral<"permission.pending">;
    interactionId: z.ZodString;
    permissionCategory: z.ZodString;
}, z.core.$strip>], "kind">;
export type NormalizedNotification = z.infer<typeof NormalizedNotificationSchema>;
export declare const NotificationPublishEnvelopeSchema: z.ZodObject<{
    type: z.ZodLiteral<"notification.publish">;
    payload: z.ZodObject<{
        notification: z.ZodDiscriminatedUnion<[z.ZodObject<{
            eventId: z.ZodString;
            route: z.ZodObject<{
                machineId: z.ZodUUID;
                instanceId: z.ZodUUID;
                projectId: z.ZodString;
                sessionId: z.ZodString;
                routeGeneration: z.ZodUUID;
            }, z.core.$strip>;
            locale: z.ZodEnum<{
                en: "en";
                "zh-TW": "zh-TW";
            }>;
            projectLabel: z.ZodString;
            sessionLabel: z.ZodString;
            rootSessionLabel: z.ZodOptional<z.ZodString>;
            occurredAt: z.ZodISODateTime;
            kind: z.ZodLiteral<"session.completed">;
            summary: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            eventId: z.ZodString;
            route: z.ZodObject<{
                machineId: z.ZodUUID;
                instanceId: z.ZodUUID;
                projectId: z.ZodString;
                sessionId: z.ZodString;
                routeGeneration: z.ZodUUID;
            }, z.core.$strip>;
            locale: z.ZodEnum<{
                en: "en";
                "zh-TW": "zh-TW";
            }>;
            projectLabel: z.ZodString;
            sessionLabel: z.ZodString;
            rootSessionLabel: z.ZodOptional<z.ZodString>;
            occurredAt: z.ZodISODateTime;
            kind: z.ZodLiteral<"session.error">;
            errorCategory: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            eventId: z.ZodString;
            route: z.ZodObject<{
                machineId: z.ZodUUID;
                instanceId: z.ZodUUID;
                projectId: z.ZodString;
                sessionId: z.ZodString;
                routeGeneration: z.ZodUUID;
            }, z.core.$strip>;
            locale: z.ZodEnum<{
                en: "en";
                "zh-TW": "zh-TW";
            }>;
            projectLabel: z.ZodString;
            sessionLabel: z.ZodString;
            rootSessionLabel: z.ZodOptional<z.ZodString>;
            occurredAt: z.ZodISODateTime;
            kind: z.ZodLiteral<"question.pending">;
            interactionId: z.ZodString;
            questions: z.ZodArray<z.ZodObject<{
                question: z.ZodString;
                header: z.ZodString;
                options: z.ZodArray<z.ZodObject<{
                    label: z.ZodString;
                    description: z.ZodString;
                }, z.core.$strip>>;
                multiple: z.ZodBoolean;
                custom: z.ZodBoolean;
            }, z.core.$strip>>;
        }, z.core.$strip>, z.ZodObject<{
            eventId: z.ZodString;
            route: z.ZodObject<{
                machineId: z.ZodUUID;
                instanceId: z.ZodUUID;
                projectId: z.ZodString;
                sessionId: z.ZodString;
                routeGeneration: z.ZodUUID;
            }, z.core.$strip>;
            locale: z.ZodEnum<{
                en: "en";
                "zh-TW": "zh-TW";
            }>;
            projectLabel: z.ZodString;
            sessionLabel: z.ZodString;
            rootSessionLabel: z.ZodOptional<z.ZodString>;
            occurredAt: z.ZodISODateTime;
            kind: z.ZodLiteral<"permission.pending">;
            interactionId: z.ZodString;
            permissionCategory: z.ZodString;
        }, z.core.$strip>], "kind">;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>;
export declare const ClientEnvelopeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"register">;
    payload: z.ZodObject<{
        packageVersion: z.ZodString;
        openCodeVersion: z.ZodString;
        machineId: z.ZodUUID;
        instanceId: z.ZodUUID;
        configFingerprint: z.ZodString;
        capabilities: z.ZodArray<z.ZodString>;
        telegram: z.ZodOptional<z.ZodObject<{
            botToken: z.ZodString;
            userId: z.ZodString;
            chatId: z.ZodString;
            locale: z.ZodEnum<{
                en: "en";
                "zh-TW": "zh-TW";
            }>;
            sessionPromptTtlMinutes: z.ZodNumber;
            questionTtlMinutes: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"route.register">;
    payload: z.ZodObject<{
        route: z.ZodObject<{
            machineId: z.ZodUUID;
            instanceId: z.ZodUUID;
            projectId: z.ZodString;
            sessionId: z.ZodString;
            routeGeneration: z.ZodUUID;
        }, z.core.$strip>;
        projectLabel: z.ZodString;
        sessionLabel: z.ZodString;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"route.unregister">;
    payload: z.ZodObject<{
        route: z.ZodObject<{
            machineId: z.ZodUUID;
            instanceId: z.ZodUUID;
            projectId: z.ZodString;
            sessionId: z.ZodString;
            routeGeneration: z.ZodUUID;
        }, z.core.$strip>;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"notification.publish">;
    payload: z.ZodObject<{
        notification: z.ZodDiscriminatedUnion<[z.ZodObject<{
            eventId: z.ZodString;
            route: z.ZodObject<{
                machineId: z.ZodUUID;
                instanceId: z.ZodUUID;
                projectId: z.ZodString;
                sessionId: z.ZodString;
                routeGeneration: z.ZodUUID;
            }, z.core.$strip>;
            locale: z.ZodEnum<{
                en: "en";
                "zh-TW": "zh-TW";
            }>;
            projectLabel: z.ZodString;
            sessionLabel: z.ZodString;
            rootSessionLabel: z.ZodOptional<z.ZodString>;
            occurredAt: z.ZodISODateTime;
            kind: z.ZodLiteral<"session.completed">;
            summary: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            eventId: z.ZodString;
            route: z.ZodObject<{
                machineId: z.ZodUUID;
                instanceId: z.ZodUUID;
                projectId: z.ZodString;
                sessionId: z.ZodString;
                routeGeneration: z.ZodUUID;
            }, z.core.$strip>;
            locale: z.ZodEnum<{
                en: "en";
                "zh-TW": "zh-TW";
            }>;
            projectLabel: z.ZodString;
            sessionLabel: z.ZodString;
            rootSessionLabel: z.ZodOptional<z.ZodString>;
            occurredAt: z.ZodISODateTime;
            kind: z.ZodLiteral<"session.error">;
            errorCategory: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            eventId: z.ZodString;
            route: z.ZodObject<{
                machineId: z.ZodUUID;
                instanceId: z.ZodUUID;
                projectId: z.ZodString;
                sessionId: z.ZodString;
                routeGeneration: z.ZodUUID;
            }, z.core.$strip>;
            locale: z.ZodEnum<{
                en: "en";
                "zh-TW": "zh-TW";
            }>;
            projectLabel: z.ZodString;
            sessionLabel: z.ZodString;
            rootSessionLabel: z.ZodOptional<z.ZodString>;
            occurredAt: z.ZodISODateTime;
            kind: z.ZodLiteral<"question.pending">;
            interactionId: z.ZodString;
            questions: z.ZodArray<z.ZodObject<{
                question: z.ZodString;
                header: z.ZodString;
                options: z.ZodArray<z.ZodObject<{
                    label: z.ZodString;
                    description: z.ZodString;
                }, z.core.$strip>>;
                multiple: z.ZodBoolean;
                custom: z.ZodBoolean;
            }, z.core.$strip>>;
        }, z.core.$strip>, z.ZodObject<{
            eventId: z.ZodString;
            route: z.ZodObject<{
                machineId: z.ZodUUID;
                instanceId: z.ZodUUID;
                projectId: z.ZodString;
                sessionId: z.ZodString;
                routeGeneration: z.ZodUUID;
            }, z.core.$strip>;
            locale: z.ZodEnum<{
                en: "en";
                "zh-TW": "zh-TW";
            }>;
            projectLabel: z.ZodString;
            sessionLabel: z.ZodString;
            rootSessionLabel: z.ZodOptional<z.ZodString>;
            occurredAt: z.ZodISODateTime;
            kind: z.ZodLiteral<"permission.pending">;
            interactionId: z.ZodString;
            permissionCategory: z.ZodString;
        }, z.core.$strip>], "kind">;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"heartbeat">;
    payload: z.ZodObject<{}, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"command.result">;
    payload: z.ZodObject<{
        commandId: z.ZodUUID;
        status: z.ZodEnum<{
            accepted: "accepted";
            rejected: "rejected";
            stale: "stale";
            indeterminate: "indeterminate";
        }>;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    protocol: z.ZodObject<{
        major: z.ZodLiteral<1>;
        minor: z.ZodNumber;
    }, z.core.$strip>;
    requestId: z.ZodUUID;
    sentAt: z.ZodISODateTime;
}, z.core.$strip>], "type">;
export type ClientEnvelope = z.infer<typeof ClientEnvelopeSchema>;
export declare const DiagnosticSchema: z.ZodObject<{
    level: z.ZodEnum<{
        error: "error";
        debug: "debug";
        info: "info";
        warn: "warn";
    }>;
    code: z.ZodString;
    message: z.ZodString;
    details: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>>>;
}, z.core.$strip>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
//# sourceMappingURL=index.d.ts.map