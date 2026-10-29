# Threat Model

This document describes the V1 security boundary for OpenCode Telegram Notifier. It is an implementation guide, not a guarantee that Telegram or the local operating-system account is a sandbox.

## Assets

Protected assets:

- Telegram bot token.
- Pinned Telegram `userId` and private `chatId`.
- Local administrator bearer secret (`broker-secret`).
- Node WebSocket bearer secret (`gateway-secret`).
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
- Loopback networking by default for native broker mode.
- Explicit private overlay interfaces such as ZeroTier or NetBird, whose membership and encryption are administered separately.
- A Docker port published specifically to `127.0.0.1` when container mode is used.
- TLS termination and network access controls when the broker is reachable through a public address.
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
| A Node credential is used against dashboard/control APIs | WebSocket nodes authenticate with `gateway-secret`; dashboard, settings, dispatch, and stop APIs require the separate `broker-secret`. |
| Credentials are exposed in URL logs | Current clients send WebSocket credentials in the `Authorization` header. During RC.8 migration only, URL query credentials remain accepted from loopback or private source addresses until the Node credential is rotated. |
| A public endpoint carries plaintext credentials | Clients reject `ws://` URLs with public IPs. Public access must terminate TLS and use `wss://`. |

## Out Of Scope

Not protected by V1:

- A malicious process running as the same OS user. It may read local config or state and impersonate the plugin.
- A compromised Telegram account, Telegram client, BotFather session, or Telegram infrastructure.
- A compromised OpenCode process or plugin host.
- Security of the configured ZeroTier, NetBird, Tailscale, firewall, DNS, or TLS infrastructure.
- Direct public exposure through `0.0.0.0` without a firewall and TLS reverse proxy.
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

Use one bot token on one Gateway. Keep token files private and prefer native loopback mode. For ZeroTier or NetBird, bind the Gateway to that interface's IP instead of `0.0.0.0`. For public access, keep the broker behind an HTTPS/WSS reverse proxy with firewall rules and rate limiting. Publish Docker ports only as `127.0.0.1:42617:42617`. Run `opencode-telegram-broker doctor` after setup, update, credential rotation, or unexpected delivery failures.
