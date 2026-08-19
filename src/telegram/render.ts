import type { NormalizedNotification } from "../protocol";
import { NormalizedNotificationSchema } from "../protocol";

const TELEGRAM_TEXT_LIMIT = 4096;
const DYNAMIC_FIELD_LIMIT = 700;
const QUESTION_TEXT_LIMIT = 900;
const OPTION_TEXT_LIMIT = 200;
const REDACTION = "[redacted]";

export type TelegramRenderOptions = {
  maxLength?: number;
  redactionPatterns?: RegExp[];
};

export type RenderedTelegramPayload = {
  text: string;
  parseMode?: "HTML";
};

export class TelegramRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramRenderError";
  }
}

export function renderTelegramNotification(
  input: unknown,
  options: TelegramRenderOptions = {},
): RenderedTelegramPayload {
  const parsed = NormalizedNotificationSchema.safeParse(input);
  if (!parsed.success) throw new TelegramRenderError("notification is not allowlisted");

  const redacted = redactNotification(parsed.data, options.redactionPatterns);
  const maxLength = options.maxLength ?? TELEGRAM_TEXT_LIMIT;
  const html = redactText(renderHtml(redacted), options.redactionPatterns);
  if (html.length <= maxLength) return { text: html, parseMode: "HTML" };

  const truncated = redactText(renderHtml(redacted, true), options.redactionPatterns);
  if (truncated.length <= maxLength) return { text: truncated, parseMode: "HTML" };

  const fallback = truncateText(
    redactText(renderPlainTextFallback(redacted), options.redactionPatterns),
    maxLength,
  );
  if (!fallback) throw new TelegramRenderError("notification could not be rendered safely");
  return { text: fallback };
}

export function sanitizeTelegramText(text: string, options: TelegramRenderOptions = {}): string {
  return truncateText(
    redactText(text, options.redactionPatterns),
    options.maxLength ?? TELEGRAM_TEXT_LIMIT,
  );
}

function renderHtml(notification: NormalizedNotification, compact = false): string {
  const lines = [
    `<b>${escapeHtml(eventTitle(notification.kind))}</b>`,
    `Project: ${escapeHtml(notification.projectLabel)}`,
    `Session: ${escapeHtml(notification.sessionLabel)}`,
  ];
  if (notification.rootSessionLabel)
    lines.push(`Root: ${escapeHtml(notification.rootSessionLabel)}`);
  lines.push(`Time: ${escapeHtml(notification.occurredAt)}`);

  switch (notification.kind) {
    case "session.completed":
      lines.push("Status: complete", "Action: reply to this message to continue the root session.");
      break;
    case "session.error":
      lines.push(
        `Status: error (${escapeHtml(notification.errorCategory)})`,
        "Action: check the terminal before continuing.",
      );
      break;
    case "question.pending":
      lines.push("Status: waiting for your answer");
      if (!compact) {
        for (const [index, question] of notification.questions.entries()) {
          lines.push(
            `Question ${index + 1}: ${escapeHtml(question.header)}`,
            escapeHtml(truncateText(question.question, QUESTION_TEXT_LIMIT)),
          );
          for (const option of question.options.slice(0, 10)) {
            lines.push(
              `- ${escapeHtml(truncateText(option.label, OPTION_TEXT_LIMIT))}: ${escapeHtml(
                truncateText(option.description, OPTION_TEXT_LIMIT),
              )}`,
            );
          }
        }
      }
      lines.push(
        "Action: answer this exact question or return to the terminal if it is ambiguous.",
      );
      break;
    case "permission.pending":
      lines.push(
        `Status: permission required (${escapeHtml(notification.permissionCategory)})`,
        "Action: use the terminal. Telegram permission approval is disabled in V1.",
      );
      break;
  }

  return lines.join("\n");
}

function renderPlainTextFallback(notification: NormalizedNotification): string {
  const context = notification.rootSessionLabel
    ? `${notification.projectLabel} / ${notification.rootSessionLabel} / ${notification.sessionLabel}`
    : `${notification.projectLabel} / ${notification.sessionLabel}`;
  return `${eventTitle(notification.kind)}\n${context}\n${notification.occurredAt}\nUse the terminal if this message is incomplete.`;
}

function eventTitle(kind: NormalizedNotification["kind"]): string {
  switch (kind) {
    case "session.completed":
      return "OpenCode session completed";
    case "session.error":
      return "OpenCode session error";
    case "question.pending":
      return "OpenCode question pending";
    case "permission.pending":
      return "OpenCode permission required";
  }
}

function redactNotification(
  notification: NormalizedNotification,
  patterns: RegExp[] | undefined,
): NormalizedNotification {
  const base = {
    projectLabel: redactDynamic(notification.projectLabel, patterns),
    sessionLabel: redactDynamic(notification.sessionLabel, patterns),
    ...(notification.rootSessionLabel
      ? { rootSessionLabel: redactDynamic(notification.rootSessionLabel, patterns) }
      : {}),
  };
  switch (notification.kind) {
    case "session.completed":
      return { ...notification, ...base };
    case "session.error":
      return {
        ...notification,
        ...base,
        errorCategory: redactDynamic(notification.errorCategory, patterns),
      };
    case "question.pending":
      return {
        ...notification,
        ...base,
        questions: notification.questions.map((question) => ({
          ...question,
          question: redactDynamic(question.question, patterns),
          header: redactDynamic(question.header, patterns),
          options: question.options.map((option) => ({
            label: redactDynamic(option.label, patterns),
            description: redactDynamic(option.description, patterns),
          })),
        })),
      };
    case "permission.pending":
      return {
        ...notification,
        ...base,
        permissionCategory: redactDynamic(notification.permissionCategory, patterns),
      };
  }
}

function redactDynamic(value: string, patterns: RegExp[] | undefined): string {
  return truncateText(redactText(value, patterns), DYNAMIC_FIELD_LIMIT);
}

export function redactText(value: string, patterns: RegExp[] = []): string {
  let result = value;
  for (const pattern of [
    /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s<>&]+/gi,
    /\b[A-Za-z0-9_-]{32,}\b/g,
    /(?:^|\s)\/[A-Za-z0-9._~+/@=-]+(?:\/[A-Za-z0-9._~+@=-]+)+/g,
    ...patterns,
  ]) {
    result = result.replace(pattern, REDACTION);
  }
  return result;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 16) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 16)} [truncated]`;
}
