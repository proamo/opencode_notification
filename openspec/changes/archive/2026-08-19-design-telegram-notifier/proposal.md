## Why

OpenCode users often run long tasks across several projects and must keep checking each terminal for completion, failures, questions, or permission requests. A Telegram integration can make this workflow asynchronous, but it must route replies to the exact OpenCode process and session without introducing a hosted service or leaking sensitive development data.

## What Changes

- Add localized Telegram notifications for session completion, errors, user questions, and permission requests.
- Add a local singleton broker that owns Telegram polling and coordinates multiple OpenCode processes on one computer.
- Identify every notification by machine, OpenCode instance, project, and session so Telegram replies reach the original target.
- Support replying to a completed session and answering a pending OpenCode question from Telegram.
- Keep remote permission approval disabled in V1 while still notifying the user that terminal intervention is required.
- Add noise controls, deduplication, redaction, expiry, delivery feedback, and root-session filtering.
- Provide guided setup, diagnostics, and explicit documentation for the single-computer limitation.
- Provide an optional single-container deployment for the local Broker while OpenCode plugins continue to run on the host.
- Establish Traditional Chinese and English notification catalogs with deterministic locale selection.

### V1 Non-goals

- Connecting one Telegram bot to brokers on multiple computers.
- A vendor-hosted relay, shared bot, account system, or telemetry service.
- Approving OpenCode permissions from Telegram.
- Queuing Telegram commands for an offline OpenCode process.
- Mirroring complete conversations, tool output, source code, or secrets to Telegram.
- Exposing the Broker beyond the local computer.

## Capabilities

### New Capabilities

- `telegram-notifications`: Event selection, localized message content, redaction, noise control, and Telegram delivery behavior.
- `local-instance-routing`: Local broker registration and exact routing across multiple OpenCode processes, projects, and sessions.
- `telegram-session-interaction`: Safe Telegram replies to continue an idle session or answer a pending question.
- `setup-and-diagnostics`: User-owned bot setup, local broker lifecycle, validation, test notifications, and documented limitations.

### Modified Capabilities

None.

## Impact

- Introduces an npm-distributed OpenCode plugin and a local broker executable.
- Uses OpenCode plugin events and SDK APIs, the Telegram Bot API, a host-local authenticated protocol, and local persistent route state.
- Adds configuration for bot credentials, allowed Telegram identity, locale, event filters, redaction, and broker behavior.
- Requires compatibility tests against supported OpenCode versions because event names and payloads can evolve.
- Creates security-sensitive paths for remote text injection and question responses; all routing and authorization failures must fail closed.
