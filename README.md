# OpenCode Telegram Notifier

OpenCode Telegram Notifier is a privacy-first OpenCode plugin for asynchronous notifications and safe remote replies. It is designed for developers who run several OpenCode projects at the same time and need every Telegram response to return to the exact originating process and session.

> Status: pre-release implementation. The package is not published to npm yet; install from a release tarball or source checkout until the first public release exists.

[繁體中文總覽](docs/README.zh-TW.md)

## V1 Scope

V1 targets one computer with:

- one user-owned Telegram bot;
- one local singleton broker;
- multiple OpenCode processes;
- multiple projects and sessions;
- English and Traditional Chinese notifications.

The notifier reports session completion, errors, questions, and permission requests. Users can reply to an eligible completion notification to continue that session and answer a pending OpenCode question from Telegram.

Remote permission approval is intentionally excluded from V1. Permission notifications direct the user back to the terminal.

## Architecture

```text
OpenCode: project A ─┐
OpenCode: project B ─┼── local broker ── Telegram Bot API
OpenCode: project C ─┘
```

Every OpenCode plugin connects to the same loopback-only broker. The broker is the only Telegram long-polling consumer, so concurrent OpenCode processes do not compete for updates.

The Broker also supports an optional single Docker container. OpenCode plugins remain on the host and connect through a port published only on `127.0.0.1`; the state directory is mounted as a persistent volume. Native mode remains the default.

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

## Installation

Requirements:

- Bun `>=1.3.0`.
- OpenCode with `@opencode-ai/plugin` `>=1.18.0 <2`.
- A user-owned Telegram bot token from BotFather.
- One computer per bot token.

From source while the package is pre-release:

```sh
bun install
bun run build
```

After npm publication, install the package in the same environment OpenCode uses for plugins:

```sh
bun add opencode-telegram-link
```

The npm package exports the plugin as `opencode-telegram-link` and installs the broker CLI as `opencode-telegram-broker`.

## Quick Start & Interactive Setup (Recommended)

1. Get a Telegram Bot Token from `@BotFather` on Telegram (`/newbot`).
2. Run the interactive setup wizard:

```sh
bun run setup
# Or after global install / npm publication:
bunx opencode-telegram-link setup
```

The interactive wizard will:
- Ask for your preferred language (Traditional Chinese / English).
- Prompt and instantly verify your Bot Token with Telegram.
- Guide you through private chat pairing with a short-lived nonce code.
- Automatically save the token in a secure private state file (`0600`/`0700`).
- Automatically detect and update your `opencode.json` configuration file.
- Send a test welcome notification to your Telegram!

---

## Non-Interactive & Scripted Setup (CI / Automated Environments)

If you prefer scripted setup with environment variables or flags:

```sh
# Pair with short-lived nonce
OPENCODE_TELEGRAM_BOT_TOKEN='123456:REPLACE_WITH_BOTFATHER_TOKEN' \
  opencode-telegram-broker setup --pair --locale en

# Or specify existing Telegram User and Chat IDs directly
OPENCODE_TELEGRAM_BOT_TOKEN_FILE=~/.local/state/opencode-telegram-link/telegram-bot-token \
  opencode-telegram-broker setup --user-id 123456789 --chat-id 123456789 --locale en
```

## Configuration

Configure the OpenCode plugin with the same pinned Telegram identity returned by setup. The exact OpenCode plugin file format depends on your OpenCode installation; the plugin options object is:

```jsonc
{
  "mode": "local",
  "locale": "auto",
  "telegram": {
    "tokenFile": "/home/you/.local/state/opencode-telegram-link/telegram-bot-token",
    "userId": "123456789",
    "chatId": "123456789"
  },
  "notifications": {
    "completion": true,
    "error": true,
    "question": true,
    "permission": true,
    "includeChildLifecycle": false,
    "completionDebounceMs": 1500,
    "pluginBufferSize": 100
  },
  "broker": {
    "host": "127.0.0.1",
    "port": 42617
  },
  "interaction": {
    "sessionPromptTtlMinutes": 1440,
    "questionTtlMinutes": 30
  }
}
```

Use exactly one of `telegram.tokenFile` or `telegram.botToken`. `tokenFile` is recommended because the file permission checker rejects group-readable, world-readable, non-regular, and wrong-owner token files on non-Windows platforms. Inline tokens are accepted for constrained environments but are easier to leak through config sharing.

## Broker Commands

Start or reuse the native loopback broker:

```sh
opencode-telegram-broker start
```

Check readiness and diagnostics:

```sh
opencode-telegram-broker status
opencode-telegram-broker doctor
```

Send a credential and chat connectivity test without creating a routable session action:

```sh
OPENCODE_TELEGRAM_BOT_TOKEN_FILE=~/.local/state/opencode-telegram-link/telegram-bot-token \
  opencode-telegram-broker test-notification --chat-id 123456789 --locale en
```

Stop the broker without terminating OpenCode sessions:

```sh
opencode-telegram-broker stop
```

Purge operational routing state only after the broker is stopped:

```sh
opencode-telegram-broker purge-state
```

Rotate the stored token file after changing the token through BotFather:

```sh
OPENCODE_TELEGRAM_BOT_TOKEN='123456:NEW_TOKEN' \
  opencode-telegram-broker rotate-credential --token-file ~/.local/state/opencode-telegram-link/telegram-bot-token
opencode-telegram-broker stop
opencode-telegram-broker start
```

## Notification Examples

Completion notification:

```text
OpenCode completed
Project: api-server
Session: Fix flaky checkout test
Reply to this message to continue the session.
```

Question notification:

```text
OpenCode needs input
Project: api-server
Question: Which migration strategy should be used?
Reply with one allowed answer, or use the terminal for full context.
```

Permission notification:

```text
OpenCode needs terminal permission
Project: api-server
Return to the terminal to approve or reject this request.
Telegram approval is disabled in V1.
```

Notification bodies are intentionally minimal. They omit transcripts, source code, tool output, local paths, and secrets by default.

## Reply Behavior

Reply directly to the original bot message. The broker routes only by the persisted Telegram message binding and opaque route identifiers; project names, session titles, and user-written IDs are never used for routing.

Supported replies:

- Reply to an eligible completed root-session notification with text to continue that exact OpenCode session.
- Reply to a pending question notification with a valid text answer or option syntax for that exact question.
- Reply to a permission notice to receive terminal-only guidance. The broker never approves or rejects permissions from Telegram in V1.

Rejected replies receive localized feedback when the route is expired, offline, stale, unauthorized, ambiguous, already handled, not actionable, or rejected by OpenCode. Offline commands are not queued.

## Docker Broker

Native mode is recommended. Docker mode runs only the broker in a container; OpenCode and plugins continue to run on the host.

Build the image from a built checkout:

```sh
bun run build
docker build -f container/broker.Dockerfile -t opencode-telegram-broker:local .
```

Run with persistent state and runtime secrets:

```sh
docker run --rm \
  --name opencode-telegram-broker \
  -p 127.0.0.1:42617:42617 \
  -v opencode-telegram-state:/state \
  -v "$HOME/.local/state/opencode-telegram-link/telegram-bot-token:/run/secrets/telegram-bot-token:ro" \
  -e OPENCODE_TELEGRAM_BOT_TOKEN_FILE=/run/secrets/telegram-bot-token \
  opencode-telegram-broker:local start
```

Do not publish the port as `42617:42617`; include the `127.0.0.1` host IP so Docker does not expose the broker on every host interface. Do not run native and Docker brokers at the same time for one state directory and bot token.

## Diagnostics

Use `opencode-telegram-broker doctor` first when setup fails or notifications stop. It checks configuration validity, token-file permissions, broker reachability, singleton conflicts, loopback binding, Telegram API connectivity, allowed identities, catalogs, and OpenCode compatibility. Output is sanitized and should not include bot tokens, broker secrets, reply text, source code, or file contents.

Common outcomes:

- `ready: true`: setup is usable.
- `warning`: setup can run but has an operational limitation, such as no active plugin registration yet.
- `failure`: fix the reported remediation before expecting notifications or replies.
- Telegram `409 Conflict`: the same bot is being polled elsewhere; stop the other consumer or use a different bot.

## Update

1. Stop idle OpenCode sessions or leave them running if you only update a compatible patch release.
2. Update the package or rebuild the checkout.
3. Restart the broker with `opencode-telegram-broker stop` and `opencode-telegram-broker start`.
4. Restart OpenCode processes if doctor reports a protocol or compatibility mismatch.
5. Run `opencode-telegram-broker doctor` and `opencode-telegram-broker test-notification --chat-id <id>`.

The broker and plugin negotiate protocol major version `1`. Incompatible upgrades fail closed instead of silently downgrading routing or reply behavior.

## Uninstall

Run the interactive uninstaller wizard:

```sh
bun run uninstall
# Or
opencode-telegram-broker uninstall
```

The uninstaller will safely:
1. Stop the running broker process.
2. Search and remove the plugin configuration from `opencode.json` files (with `.bak` backup).
3. Clear SQLite database and message routing state.
4. Prompt to remove the private token file and state directory.

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
- [Threat model](docs/threat-model.md)
- [Local broker protocol](docs/protocol.md)
- [Data retention](docs/data-retention.md)
- [Contributor guide](docs/contributing.md)
- [GitNexus release readiness](docs/gitnexus-release-readiness.md)

The OpenSpec artifacts are the current source of truth. Requirements use RFC 2119 language and testable scenarios.

## Technology

- TypeScript and Bun
- `@opencode-ai/plugin` and the OpenCode SDK
- Telegram Bot API with long polling
- Authenticated loopback WebSocket protocol
- SQLite for minimal route, delivery, and idempotency state

The project uses the MIT License. `opencode-telegram-link` is the current working npm package name and may be changed before the first public release.
