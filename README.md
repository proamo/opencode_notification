# OpenCode Telegram Notifier

OpenCode Telegram Notifier is a privacy-first OpenCode plugin for asynchronous notifications, interactive inline buttons, and safe remote replies. It is designed for developers who run several OpenCode projects at the same time and need every Telegram response to return to the exact originating process and session.

> Version: **v1.5.0** (Interactive Telegram Inline Keyboard, Remote Permission Approvals & AI Execution Summaries).
> Status: Pre-release implementation. Install from a release tarball or source checkout until the first public npm package is published.

[繁體中文總覽](docs/README.zh-TW.md)

## V1.5 Features & Scope

V1.5 targets one computer with:

- **Interactive Inline Buttons**: Single-tap remote permission approvals (`[ ✅ Allow Once ]`, `[ ⚡ Always Allow ]`, `[ ❌ Reject ]`) and question option selections right inside Telegram.
- **AI Execution Summaries**: Task completion notifications automatically include a concise AI-generated summary of actions taken.
- **Host Local Time**: Timestamps formatted in the server host's local timezone.
- **Session Hot Fallback**: Seamless message routing across OpenCode restarts, reconnects, and scheduled Telegram replies.
- **One User-Owned Telegram Bot & Local Singleton Broker**: Multiplexing concurrent OpenCode processes through a single loopback Broker without update collisions.
- **Multi-Project & Multi-Session Isolation**: Absolute routing precision based on machine, project, and session identities.
- **Bilingual Support**: Full Traditional Chinese (`zh-TW`) and English (`en`) notifications and guidance.

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

## Quick Start (4-Step Setup)

On any machine (development host or remote server) where you want to enable notifications:

```sh
# 1. Clone the repository
git clone https://github.com/proamo/opencode_notification.git
cd opencode_notification

# 2. Install dependencies
bun install

# 3. Build the project
bun run build

# 4. Run the interactive setup wizard
bun run setup
```

*(Note: Once published to npm, you will also be able to run `bunx opencode-telegram-link setup` directly).*

The interactive wizard will:
- Ask for your preferred language (Traditional Chinese / English).
- Ask for your preferred deployment mode:
  - **1) Native Mode (Default)**: Broker runs as a lightweight background process, auto-spawned by OpenCode.
  - **2) Docker Container Mode**: The wizard will **automatically build and start the Docker container in the background** via Docker Compose!
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

OpenCode supports both **Global Configuration** and **Project-Specific Configuration**:

- **Global Config**: `~/.config/opencode/opencode.json` (applied to all projects).
- **Project-Specific Config**: `<project-root>/.opencode/opencode.json` or `<project-root>/opencode.json`.

> ⚠️ **Important: Project Config Overrides Global Plugins**
> If your project contains its own `.opencode/opencode.json` or `opencode.json` that defines a `"plugin"` array, OpenCode will use that workspace `"plugin"` list and **will not inherit** plugins from your global configuration.
> 
> Therefore, if a project has its own `opencode.json`, you **must** also add the notification plugin to that project's configuration.

### How to Configure a Project with its Own `opencode.json`

#### Option 1: Manual Edit (Recommended)
Open your project's `.opencode/opencode.json` (or `opencode.json`) and add the absolute directory path to the `"plugin"` array:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "oc-codex-multi-auth@6.12.1",
    "/home/you/opencode_notification"
  ]
}
```

> 💡 **Local Install vs npm Package**: Until published on the official npm registry, specify the absolute directory path to this repository. Once published, you can simply write `"opencode-telegram-link"`. The plugin automatically reads the paired credentials from the secure local state directory.

#### Option 2: Automatic Injection via Setup Wizard
You can run the setup tool directly inside your target project workspace:

```sh
cd /path/to/your/project
bun run --cwd /path/to/opencode_notification setup --config-only
```
The wizard will automatically detect the local workspace `opencode.json`, create a `.bak` backup, and inject the plugin entry safely.

### Permission Configuration (Automatic Command Execution)
 
To allow shell and file operations without manual approval prompts, configure permissions in `opencode.json` or in your `.opencode/agent/<agent-name>.md`:
 
```json
{
  "permission": {
    "edit": "allow",
    "bash": "allow",
    "webfetch": "allow",
    "task": "allow",
    "external_directory": "allow"
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

## Sample Notifications
 
### 1. Task Completed Notification (with AI Summary & Local Time)

```text
OpenCode Completed
Project: api-server
Session: Fix flaky checkout test
Time: 2026-08-26 09:30:15

📝 Summary:
Fixed race condition in Stripe webhook handler by wrapping state lookup in a database transaction. Added unit test.

Reply to this message to continue the session.
```

### 2. Interactive Permission Request (V1.5 Inline Keyboard)

```text
OpenCode Needs Permission
Project: api-server
Session: Fix flaky checkout test
Time: 2026-08-26 09:32:00
Action: Execute bash command `npm run test:e2e`

[ ✅ Allow Once ]   [ ⚡ Always Allow ]   [ ❌ Reject ]
```

### 3. Interactive Question Notification (V1.5 Option Buttons)

```text
OpenCode Needs Input
Project: api-server
Question: Which migration strategy should be used?
Time: 2026-08-26 09:35:10

[ Blue-Green ]   [ Canary ]   [ In-Place ]
```

Notification bodies are intentionally minimal. They omit raw transcripts, source code, tool output, local filesystem paths, and secrets by default.

## Reply & Interaction Behavior

- **Interactive Permission Approval**: Tap `[ ✅ Allow Once ]`, `[ ⚡ Always Allow ]`, or `[ ❌ Reject ]` on the Telegram message. The Broker validates a single-use token and remotely unblocks OpenCode in the terminal immediately!
- **Interactive Question Selection**: Tap an option button on the Telegram question notification, or reply directly with text.
- **Continue Session**: Reply directly with text to any completed task notification to send a new prompt to that exact OpenCode session (active for 24 hours).

Rejected replies receive localized feedback when the route is expired, offline, unauthorized, or rejected by OpenCode. Offline commands are not queued.

## Docker Broker

Native mode is recommended. Docker mode runs only the broker in a container; OpenCode and plugins continue to run on the host.

### Quick Start with Docker Compose (Recommended)

```sh
docker compose up -d --build
```

To stop:
```sh
docker compose down
```

### Manual Container Run

```sh
bun run build
docker build -f container/broker.Dockerfile -t opencode-telegram-broker:local .

docker run -d --rm \
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
- [Future Architecture & Roadmap (V2/V3)](docs/future-architecture-spec.md)
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
