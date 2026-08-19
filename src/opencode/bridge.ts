import { createHash } from "node:crypto";
import type { SupportedLocale } from "../i18n";
import type { RouteIntent } from "../plugin/client";
import type { NormalizedNotification, RouteKey } from "../protocol";
import { type NotificationSourceEvent, normalizeOpenCodeEvent } from "./events";

type RouteClient = {
  upsertRoute(intent: RouteIntent): Promise<RouteKey | undefined>;
  removeRoute(projectId: string, sessionId: string): Promise<void>;
  activeRoute(projectId: string, sessionId: string): RouteKey | undefined;
};

type SessionState = { title: string; parentId?: string };

type NotificationFilters = {
  completion: boolean;
  error: boolean;
  question: boolean;
  permission: boolean;
};

type NotificationResult =
  | { status: "ready"; notification: NormalizedNotification }
  | { status: "retry" }
  | { status: "drop" };

type BufferedSourceEvent = {
  key: string;
  event: NotificationSourceEvent;
  occurredAt: Date;
  expiresAt: number;
  priority: number;
  sequence: number;
};

type BufferedNotification = {
  notification: NormalizedNotification;
  expiresAt: number;
  priority: number;
  sequence: number;
};

type PendingCompletion = {
  event: NotificationSourceEvent;
  occurredAt: Date;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_FILTERS: NotificationFilters = {
  completion: true,
  error: true,
  question: true,
  permission: true,
};
const DEFAULT_COMPLETION_DEBOUNCE_MS = 1_500;
const DEFAULT_BUFFER_LIMIT = 100;
const DEFAULT_DEDUPE_TTL_MS = 7 * 24 * 60 * 60_000;
const COMPLETION_OR_ERROR_TTL_MS = 24 * 60 * 60_000;
const ACTION_REQUIRED_TTL_MS = 30 * 60_000;
const BUFFER_RETRY_MS = 250;

export type OpenCodeEventBridgeOptions = {
  broker: RouteClient;
  projectId: string;
  projectLabel: string;
  locale: SupportedLocale;
  now?: () => Date;
  notificationFilters?: Partial<NotificationFilters>;
  includeChildLifecycle?: boolean;
  completionDebounceMs?: number;
  bufferLimit?: number;
  dedupeTtlMs?: number;
  onNotification: (notification: NormalizedNotification) => void | Promise<void>;
  onDiagnostic?: (code: string, eventType: string) => void;
};

export class OpenCodeEventBridge {
  readonly #broker: RouteClient;
  readonly #projectId: string;
  readonly #projectLabel: string;
  readonly #locale: SupportedLocale;
  readonly #now: () => Date;
  readonly #filters: NotificationFilters;
  readonly #includeChildLifecycle: boolean;
  readonly #completionDebounceMs: number;
  readonly #bufferLimit: number;
  readonly #dedupeTtlMs: number;
  readonly #onNotification: OpenCodeEventBridgeOptions["onNotification"];
  readonly #onDiagnostic: NonNullable<OpenCodeEventBridgeOptions["onDiagnostic"]>;
  readonly #sessions = new Map<string, SessionState>();
  readonly #fallbackEventIds = new Map<string, string>();
  readonly #dedupe = new Map<string, number>();
  readonly #pendingCompletions = new Map<string, PendingCompletion>();
  readonly #sourceBuffer: BufferedSourceEvent[] = [];
  readonly #notificationBuffer: BufferedNotification[] = [];
  #sequence = 0;
  #sourceFlushTimer: ReturnType<typeof setTimeout> | undefined;
  #notificationFlushTimer: ReturnType<typeof setTimeout> | undefined;
  #notificationFlushRunning = false;

  constructor(options: OpenCodeEventBridgeOptions) {
    this.#broker = options.broker;
    this.#projectId = options.projectId;
    this.#projectLabel = options.projectLabel;
    this.#locale = options.locale;
    this.#now = options.now ?? (() => new Date());
    this.#filters = { ...DEFAULT_FILTERS, ...options.notificationFilters };
    this.#includeChildLifecycle = options.includeChildLifecycle ?? false;
    this.#completionDebounceMs = options.completionDebounceMs ?? DEFAULT_COMPLETION_DEBOUNCE_MS;
    this.#bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
    this.#dedupeTtlMs = options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
    this.#onNotification = options.onNotification;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
  }

  dispose(): void {
    for (const pending of this.#pendingCompletions.values()) clearTimeout(pending.timer);
    this.#pendingCompletions.clear();
    if (this.#sourceFlushTimer) clearTimeout(this.#sourceFlushTimer);
    if (this.#notificationFlushTimer) clearTimeout(this.#notificationFlushTimer);
    this.#sourceFlushTimer = undefined;
    this.#notificationFlushTimer = undefined;
  }

  async flush(): Promise<void> {
    for (const pending of this.#pendingCompletions.values()) {
      clearTimeout(pending.timer);
      this.#emitSourceEvent(pending.event, pending.occurredAt, false);
    }
    this.#pendingCompletions.clear();
    if (this.#sourceFlushTimer) {
      clearTimeout(this.#sourceFlushTimer);
      this.#sourceFlushTimer = undefined;
      this.#flushSourceBuffer();
    }
    await this.#flushNotificationBuffer();
  }

  async handle(input: unknown): Promise<void> {
    const result = normalizeOpenCodeEvent(input);
    if (result.status === "ignored") return;
    if (result.status === "invalid") {
      this.#onDiagnostic(result.code, result.eventType);
      return;
    }
    if (result.status === "session") {
      if (result.event.kind === "session.delete") {
        this.#sessions.delete(result.event.sessionId);
        this.#cancelCompletion(result.event.sessionId);
        this.#deleteFallbackTransitions(result.event.sessionId);
        this.#removeBufferedSources(result.event.sessionId);
        await this.#broker.removeRoute(this.#projectId, result.event.sessionId);
        return;
      }
      this.#cancelCompletion(result.event.sessionId);
      this.#deleteFallbackTransitions(result.event.sessionId);
      this.#sessions.set(result.event.sessionId, {
        title: result.event.title,
        ...(result.event.parentId ? { parentId: result.event.parentId } : {}),
      });
      await this.#broker.upsertRoute({
        projectId: this.#projectId,
        sessionId: result.event.sessionId,
        projectLabel: this.#projectLabel,
        sessionLabel: result.event.title,
      });
      this.#scheduleSourceFlush(0);
      return;
    }

    this.#handleSourceEvent(result.event, this.#now());
  }

  #handleSourceEvent(event: NotificationSourceEvent, occurredAt: Date): void {
    if (!this.#isEnabled(event) || !this.#passesRootPolicy(event)) return;
    if (event.kind === "session.completed") {
      this.#debounceCompletion(event, occurredAt);
      return;
    }
    this.#emitSourceEvent(event, occurredAt, true);
  }

  #emitSourceEvent(
    event: NotificationSourceEvent,
    occurredAt: Date,
    allowBuffer: boolean,
  ): boolean {
    const result = this.#createNotification(event, occurredAt);
    if (result.status === "drop") return true;
    if (result.status === "retry") {
      if (allowBuffer) this.#bufferSourceEvent(event, occurredAt);
      return false;
    }
    if (!this.#claimNotification(result.notification)) return true;
    this.#enqueueNotification(result.notification, this.#expiresAt(event, occurredAt));
    return true;
  }

  #createNotification(event: NotificationSourceEvent, occurredAt: Date): NotificationResult {
    const session = this.#sessions.get(event.sessionId);
    const route = this.#broker.activeRoute(this.#projectId, event.sessionId);
    if (!session) {
      this.#onDiagnostic("SESSION_ROUTE_UNAVAILABLE", event.kind);
      return { status: "drop" };
    }
    if (!route) {
      return { status: "retry" };
    }

    const base = {
      eventId: this.#eventId(event),
      route,
      locale: this.#locale,
      projectLabel: this.#projectLabel,
      sessionLabel: session.title,
      ...this.#rootLabel(session),
      occurredAt: occurredAt.toISOString(),
    };

    switch (event.kind) {
      case "session.completed":
        return { status: "ready", notification: { ...base, kind: event.kind } };
      case "session.error":
        return {
          status: "ready",
          notification: { ...base, kind: event.kind, errorCategory: event.errorCategory },
        };
      case "question.pending":
        return {
          status: "ready",
          notification: {
            ...base,
            kind: event.kind,
            interactionId: event.interactionId,
            questions: event.questions,
          },
        };
      case "permission.pending":
        return {
          status: "ready",
          notification: {
            ...base,
            kind: event.kind,
            interactionId: event.interactionId,
            permissionCategory: event.permissionCategory,
          },
        };
    }
  }

  #debounceCompletion(event: NotificationSourceEvent, occurredAt: Date): void {
    this.#cancelCompletion(event.sessionId);
    if (this.#completionDebounceMs <= 0) {
      this.#emitSourceEvent(event, occurredAt, true);
      return;
    }
    const timer = setTimeout(() => {
      this.#pendingCompletions.delete(event.sessionId);
      this.#emitSourceEvent(event, occurredAt, true);
    }, this.#completionDebounceMs);
    timer.unref?.();
    this.#pendingCompletions.set(event.sessionId, { event, occurredAt, timer });
  }

  #cancelCompletion(sessionId: string): void {
    const pending = this.#pendingCompletions.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingCompletions.delete(sessionId);
  }

  #bufferSourceEvent(event: NotificationSourceEvent, occurredAt: Date): void {
    this.#purgeExpiredBuffers();
    const key = this.#sourceBufferKey(event);
    if (this.#sourceBuffer.some((item) => item.key === key)) return;
    const item: BufferedSourceEvent = {
      key,
      event,
      occurredAt,
      expiresAt: this.#expiresAt(event, occurredAt),
      priority: this.#priority(event.kind),
      sequence: ++this.#sequence,
    };
    const dropped = addBounded(this.#sourceBuffer, item, this.#bufferLimit);
    if (dropped) this.#onDiagnostic("NOTIFICATION_BUFFER_OVERFLOW", dropped.event.kind);
    this.#scheduleSourceFlush(BUFFER_RETRY_MS);
  }

  #scheduleSourceFlush(delayMs: number): void {
    if (this.#sourceFlushTimer) clearTimeout(this.#sourceFlushTimer);
    this.#sourceFlushTimer = setTimeout(() => {
      this.#sourceFlushTimer = undefined;
      this.#flushSourceBuffer();
    }, delayMs);
    this.#sourceFlushTimer.unref?.();
  }

  #flushSourceBuffer(): void {
    this.#purgeExpiredBuffers();
    if (this.#sourceBuffer.length === 0) return;
    const pending = this.#sourceBuffer.splice(0);
    for (const item of pending) {
      if (item.expiresAt <= this.#now().getTime()) continue;
      if (!this.#emitSourceEvent(item.event, item.occurredAt, false)) this.#sourceBuffer.push(item);
    }
    if (this.#sourceBuffer.length > 0) this.#scheduleSourceFlush(BUFFER_RETRY_MS);
  }

  #enqueueNotification(notification: NormalizedNotification, expiresAt: number): void {
    this.#purgeExpiredBuffers();
    const item: BufferedNotification = {
      notification,
      expiresAt,
      priority: this.#priority(notification.kind),
      sequence: ++this.#sequence,
    };
    const dropped = addBounded(this.#notificationBuffer, item, this.#bufferLimit);
    if (dropped) this.#onDiagnostic("NOTIFICATION_BUFFER_OVERFLOW", dropped.notification.kind);
    this.#scheduleNotificationFlush(0);
  }

  #scheduleNotificationFlush(delayMs: number): void {
    if (this.#notificationFlushTimer) return;
    this.#notificationFlushTimer = setTimeout(() => {
      this.#notificationFlushTimer = undefined;
      void this.#flushNotificationBuffer();
    }, delayMs);
    this.#notificationFlushTimer.unref?.();
  }

  async #flushNotificationBuffer(): Promise<void> {
    if (this.#notificationFlushRunning) return;
    this.#notificationFlushRunning = true;
    try {
      this.#purgeExpiredBuffers();
      while (this.#notificationBuffer.length > 0) {
        const item = this.#notificationBuffer[0];
        if (!item || item.expiresAt <= this.#now().getTime()) {
          this.#notificationBuffer.shift();
          continue;
        }
        try {
          await this.#onNotification(item.notification);
          this.#notificationBuffer.shift();
        } catch {
          this.#onDiagnostic("NOTIFICATION_BUFFERED", item.notification.kind);
          this.#scheduleNotificationFlush(BUFFER_RETRY_MS);
          break;
        }
      }
    } finally {
      this.#notificationFlushRunning = false;
    }
  }

  #claimNotification(notification: NormalizedNotification): boolean {
    const now = this.#now().getTime();
    this.#purgeDedupe(now);
    const key = JSON.stringify([
      notification.route.machineId,
      notification.route.instanceId,
      notification.route.projectId,
      notification.route.sessionId,
      notification.route.routeGeneration,
      notification.kind,
      notification.eventId,
    ]);
    if (this.#dedupe.has(key)) return false;
    this.#dedupe.set(key, now + this.#dedupeTtlMs);
    return true;
  }

  #purgeDedupe(now: number): void {
    for (const [key, expiresAt] of this.#dedupe) {
      if (expiresAt <= now) this.#dedupe.delete(key);
    }
  }

  #purgeExpiredBuffers(): void {
    const now = this.#now().getTime();
    removeExpired(this.#sourceBuffer, now);
    removeExpired(this.#notificationBuffer, now);
  }

  #isEnabled(event: NotificationSourceEvent): boolean {
    switch (event.kind) {
      case "session.completed":
        return this.#filters.completion;
      case "session.error":
        return this.#filters.error;
      case "question.pending":
        return this.#filters.question;
      case "permission.pending":
        return this.#filters.permission;
    }
  }

  #passesRootPolicy(event: NotificationSourceEvent): boolean {
    if (event.kind !== "session.completed" && event.kind !== "session.error") return true;
    if (this.#includeChildLifecycle) return true;
    const session = this.#sessions.get(event.sessionId);
    return Boolean(session && !session.parentId);
  }

  #eventId(event: NotificationSourceEvent): string {
    if (event.sourceEventId) return event.sourceEventId;
    const key = this.#transitionKey(event);
    const existing = this.#fallbackEventIds.get(key);
    if (existing) return existing;
    const generated = `generated:${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;
    this.#fallbackEventIds.set(key, generated);
    return generated;
  }

  #transitionKey(event: NotificationSourceEvent): string {
    switch (event.kind) {
      case "session.completed":
        return `${event.kind}:${event.sessionId}`;
      case "session.error":
        return `${event.kind}:${event.sessionId}:${event.errorCategory}`;
      case "question.pending":
      case "permission.pending":
        return `${event.kind}:${event.sessionId}:${event.interactionId}`;
    }
  }

  #deleteFallbackTransitions(sessionId: string): void {
    for (const key of this.#fallbackEventIds.keys()) {
      if (key.includes(`:${sessionId}`)) this.#fallbackEventIds.delete(key);
    }
  }

  #removeBufferedSources(sessionId: string): void {
    for (let index = this.#sourceBuffer.length - 1; index >= 0; index -= 1) {
      if (this.#sourceBuffer[index]?.event.sessionId === sessionId)
        this.#sourceBuffer.splice(index, 1);
    }
  }

  #sourceBufferKey(event: NotificationSourceEvent): string {
    return JSON.stringify([
      event.kind,
      event.sessionId,
      this.#transitionKey(event),
      event.sourceEventId,
    ]);
  }

  #expiresAt(event: NotificationSourceEvent, occurredAt: Date): number {
    const ttl =
      event.kind === "question.pending" || event.kind === "permission.pending"
        ? ACTION_REQUIRED_TTL_MS
        : COMPLETION_OR_ERROR_TTL_MS;
    return occurredAt.getTime() + ttl;
  }

  #priority(kind: NotificationSourceEvent["kind"]): number {
    switch (kind) {
      case "question.pending":
      case "permission.pending":
        return 3;
      case "session.error":
        return 2;
      case "session.completed":
        return 1;
    }
  }

  #rootLabel(session: SessionState): { rootSessionLabel?: string } {
    let current = session;
    const visited = new Set<SessionState>();
    while (current.parentId) {
      if (visited.has(current)) return {};
      visited.add(current);
      const parent = this.#sessions.get(current.parentId);
      if (!parent) return {};
      current = parent;
    }
    return current === session ? {} : { rootSessionLabel: current.title };
  }
}

function addBounded<T extends { priority: number; sequence: number }>(
  items: T[],
  item: T,
  limit: number,
): T | undefined {
  items.push(item);
  items.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
  if (items.length <= limit) return undefined;
  let dropIndex = 0;
  for (let index = 1; index < items.length; index += 1) {
    const current = items[index];
    const candidate = items[dropIndex];
    if (
      current &&
      candidate &&
      (current.priority < candidate.priority ||
        (current.priority === candidate.priority && current.sequence < candidate.sequence))
    ) {
      dropIndex = index;
    }
  }
  const [dropped] = items.splice(dropIndex, 1);
  return dropped;
}

function removeExpired<T extends { expiresAt: number }>(items: T[], now: number): void {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if ((items[index]?.expiresAt ?? 0) <= now) items.splice(index, 1);
  }
}
