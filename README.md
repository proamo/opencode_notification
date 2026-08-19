# OpenCode Telegram Notifier

OpenCode Telegram Notifier is a privacy-first OpenCode plugin for asynchronous notifications and safe remote replies. It is being designed for developers who run several OpenCode projects at the same time and need every Telegram response to return to the exact originating process and session.

> Status: specification and architecture phase. No installable release exists yet.

[繁體中文總覽](docs/README.zh-TW.md)

## V1 Scope

V1 targets one computer with:

- one user-owned Telegram bot;
- one local singleton broker;
- multiple OpenCode processes;
- multiple projects and sessions;
- English and Traditional Chinese notifications.

The notifier will report session completion, errors, questions, and permission requests. Users will be able to reply to an eligible completion notification to continue that session and answer a pending OpenCode question from Telegram.

Remote permission approval is intentionally excluded from V1. Permission notifications direct the user back to the terminal.

## Architecture

```text
OpenCode: project A ─┐
OpenCode: project B ─┼── local broker ── Telegram Bot API
OpenCode: project C ─┘
```

Every OpenCode plugin connects to the same loopback-only broker. The broker is the only Telegram long-polling consumer, so concurrent OpenCode processes do not compete for updates.

The Broker will also support an optional single Docker container. OpenCode plugins remain on the host and connect through a port published only on `127.0.0.1`; the state directory is mounted as a persistent volume. Native mode remains the default.

Each actionable message is bound to an opaque route containing machine, instance, project, session, and route-generation identities. A Telegram reply must reference the original bot message; display names and user-provided route text are never used for routing.

## Security and Privacy

- The broker listens only on loopback and requires a current-user local secret.
- V1 uses the user's own bot and has no hosted relay, account service, or telemetry.
- Notifications omit transcripts, source code, tool output, paths, and secrets by default.
- Telegram user and private-chat identities are pinned during setup.
- Offline, stale, ambiguous, or unauthorized actions fail closed and are never queued.
- Telegram necessarily receives the notification and reply content that the user enables.

## Important Limitation

V1 does not support using the same Telegram bot on multiple computers. Telegram long polling allows one effective consumer, so multiple computers can consume each other's updates or produce `409 Conflict` errors.

A future version may offer a separately designed remote-broker mode selected during installation. V1 contains no dormant LAN listener or unaudited remote access path.

## Specifications

- [Proposal](openspec/changes/design-telegram-notifier/proposal.md)
- [Technical design](openspec/changes/design-telegram-notifier/design.md)
- [Telegram notifications](openspec/changes/design-telegram-notifier/specs/telegram-notifications/spec.md)
- [Local instance routing](openspec/changes/design-telegram-notifier/specs/local-instance-routing/spec.md)
- [Telegram session interaction](openspec/changes/design-telegram-notifier/specs/telegram-session-interaction/spec.md)
- [Setup and diagnostics](openspec/changes/design-telegram-notifier/specs/setup-and-diagnostics/spec.md)
- [Implementation tasks](openspec/changes/design-telegram-notifier/tasks.md)
- [Compatibility policy](docs/compatibility.md)
- [Local state management](docs/state-management.md)

The OpenSpec artifacts are the current source of truth. Requirements use RFC 2119 language and testable scenarios.

## Planned Technology

- TypeScript and Bun
- `@opencode-ai/plugin` and the OpenCode SDK
- Telegram Bot API with long polling
- Authenticated loopback WebSocket protocol
- SQLite for minimal route, delivery, and idempotency state

The project uses the MIT License. `opencode-telegram-link` is the current working npm package name and may be changed before the first public release.
