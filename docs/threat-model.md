# Threat Model

This document describes the V1 security boundary for OpenCode Telegram Notifier. It is an implementation guide, not a guarantee that Telegram or the local operating-system account is a sandbox.

## Assets

Protected assets:

- Telegram bot token.
- Pinned Telegram `userId` and private `chatId`.
- Broker bearer secret.
- Machine identity and route salt.
- Opaque route keys that bind Telegram messages to OpenCode instances, projects, sessions, and route generations.
- Local SQLite state, including redacted outbound payloads, update offsets, route bindings, callback tokens, and idempotency records.
- User reply text while it is being processed.

Data intentionally minimized:

- Source code and tool output are not included in notifications by default.
- Canonical project paths are converted to opaque HMAC project IDs before leaving the plugin.
- Raw Telegram replies are not stored in SQLite.
- Bot tokens and broker secrets are not logged or stored in SQLite.

## Trust Boundaries

V1 trusts these boundaries:

- The current operating-system user account.
- Loopback-only host networking for native broker mode.
- A Docker port published specifically to `127.0.0.1` when container mode is used.
- Telegram private chat identity pinned during setup.
- OpenCode plugin APIs within the documented compatibility range.

V1 does not trust these inputs:

- Telegram updates from other users, groups, channels, forwarded messages, sender chats, business messages, or bots.
- User-provided project names, session labels, message text, or IDs for routing.
- Any process listening on the broker port unless it passes authenticated health checks.
- Unknown OpenCode event shapes or unsupported remote interaction APIs.

## In Scope Threats

| Threat | Control |
|---|---|
| Another Telegram user sends commands to the bot | The broker authorizes only the pinned private user/chat and rejects unsupported update origins. |
| Two OpenCode projects have the same display name | Routing uses opaque route keys and Telegram message bindings, never display labels. |
| A stale Telegram reply targets a replaced route | Route generation and active route ownership must still match. |
| A reply arrives after the OpenCode process disconnects | The broker marks the route offline, sends feedback, and does not queue the command. |
| Multiple local broker candidates start concurrently | The exclusive port elects one broker; losers authenticate the existing broker or fail as a conflict. |
| A non-broker process occupies the port | Health probing requires the local broker secret and reports a singleton conflict. |
| Token files are accidentally group/world readable | Setup and runtime token-file validation reject unsafe files on non-Windows platforms. |
| Telegram `getUpdates` conflicts with another consumer | The poller treats `409 Conflict` as terminal and diagnostics report the unsupported configuration. |
| Telegram retry or duplicate delivery repeats an update | The update offset and inbound update table provide idempotency. |
| Package upgrade changes protocol behavior | Protocol major negotiation fails closed; incompatible brokers/plugins require restart. |

## Out Of Scope

Not protected by V1:

- A malicious process running as the same OS user. It may read local config or state and impersonate the plugin.
- A compromised Telegram account, Telegram client, BotFather session, or Telegram infrastructure.
- A compromised OpenCode process or plugin host.
- Multi-computer use with one bot token.
- LAN or internet access to the broker.
- Telegram-based permission approval or rejection.
- End-to-end secrecy from Telegram for message text that the user enables for notification or reply.

## Fail-Closed Rules

The implementation must reject rather than guess when:

- The update is not from the pinned private user/chat.
- The Telegram message is not a direct reply to a known bot message for message-based actions.
- The callback token is missing, expired, consumed, malformed, or bound to another message.
- The route is expired, offline, inactive, stale, or owned by another connection.
- The command result is rejected, stale, indeterminate, or mismatched.
- State cannot be durably written before advancing the Telegram update offset.
- The configured bot identity differs from the bot identity pinned in local state.

## Operational Guidance

Use one bot token on one computer. Keep token files private, prefer native loopback mode, publish Docker ports only as `127.0.0.1:42617:42617`, and run `opencode-telegram-broker doctor` after setup, update, credential rotation, or unexpected delivery failures.
