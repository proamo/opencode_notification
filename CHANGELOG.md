# Changelog

All notable changes to this project are documented here. Run `bun run release:changelog` before tagging a release.

## 1.0.0-rc.9 - 2026-09-01

- Keep the persisted Telegram poller alive without OpenCode WebSocket clients and report terminal polling failures as degraded.
- Restore Telegram daemon configuration from private setup state, including Docker deployments that mount only `/state`.
- Default native Gateways to loopback while supporting explicit ZeroTier, NetBird, Tailscale, and other interface IPs.
- Require WSS for public Gateway addresses and move WebSocket credentials from URL queries to authorization headers.
- Separate Node (`gateway-secret`) and administrator (`broker-secret`) credentials with a migration-safe rotation path.
- Restrict Telegram runtime configuration to locally authenticated plugins, including deployments behind a reverse proxy.
- Preserve exact OpenCode plugin entries and nested credentials during schema-safe config migration.
- Install a stable systemd bundle, restart it on upgrades, and fail closed on service or Docker uninstall errors.
- Store Dashboard and setup credentials atomically in private files and reject symlinked settings.
- Deduplicate repeated OpenCode plugin factory initialization with one stable instance identity per process and project, so Commander connections match actual OpenCode windows.
- Separate routable sessions from active execution state so idle sessions remain available for exact continuation without inflating active-session counts.
- Route lifecycle commands, doctor, and fail-closed uninstall through the configured or persisted Gateway host and port instead of assuming loopback defaults.
- Reject public plaintext administrator control, isolate stable instance IDs across machines and symlink aliases, and make doctor/uninstall deployment-role aware.
- Persist exact Docker Compose ownership for verified uninstall and prevent in-flight completions from recreating deleted routes.
- Preserve Gateway-owned state during Node setup/uninstall, honor custom Docker state roots, and cancel route registrations superseded by deletion.
- Redact manual Node credentials, harden config backups and role exclusivity, require explicit legacy uninstall ownership, and restrict cancellation to active sessions.
- Disable legacy URL credentials after Gateway secret rotation, reject markerless Gateway state during Node setup, and make direct Docker startup use a writable named volume.
- Fail closed on falsy legacy notifier entries instead of silently loading persisted fallback credentials.
- Drop stale busy events after session deletion and reject missing or malformed explicit plugin options before fallback resolution.
- Prevent plugins targeting managed private Broker endpoints from spawning competing Telegram pollers during service restarts.
- Retry managed Broker startup without dropping plugin hooks, preserve wildcard bind hosts, and verify systemd remains active after installation.
- Enforce persisted deployment ownership at Broker startup so stale clients cannot bind a second endpoint or poll Telegram.
- Persist native bind ownership directly in deployment state and require migration when legacy ownership has no endpoint source.

## 1.0.0-rc.8 - 2026-09-01

- Auto-start Telegram Poller daemon on Gateway startup if credentials exist in stateDirectory, allowing 24/7 standalone Telegram bot slash command handling (`/status`, `/help`, etc.) even when no OpenCode client is attached.

## 1.0.0-rc.7 - 2026-09-01

- Default `DEFAULT_BIND_HOST` in BrokerServer core to `0.0.0.0` for full multi-host network accessibility.

## 1.0.0-rc.6 - 2026-09-01

- Default Gateway broker binding host to `0.0.0.0` in both `setup` wizard and `spawnDetachedBroker` to allow external and ZeroTier/LAN network access.

## 1.0.0-rc.5 - 2026-09-01

- Add automatic Systemd service registration during `setup` for Linux Gateways to support auto-start on boot.
- Add automatic Systemd service uninstallation during `uninstall`.
- Normalize CLI broker subcommands to support both `start`, `run`, and `broker start`.

## 1.0.0-rc.4 - 2026-08-31

- Fix OpenCode `ConfigInvalidError` by purging invalid root-level keys from `opencode.jsonc` and ensuring strict schema tuple compliance.
- Deduplicate and replace legacy local file URLs during config injection and uninstallation.

## 1.0.0-rc.3 - 2026-08-31

- Fix terminal hanging after interactive setup and uninstall wizards by releasing standard input streams and explicitly terminating the process on completion.

## 1.0.0-rc.2 - 2026-08-31

- Fix unhandled poller rejection during shutdown to ensure complete server, database, and discovery cleanup.
- Add repository URL and provenance metadata in package.json for OIDC Sigstore verification.

## 1.0.0-rc.1 - 2026-08-28

- Add OpenCode Commander Web Dashboard with live cluster topology and metrics.
- Add proactive remote task dispatching and live session cancellation.
- Add multi-engine voice speech-to-text (Cloudflare Workers AI, Groq Whisper, OpenAI Whisper, Custom Endpoint).
- Add multi-host Hub-and-Spoke Gateway and Node Agent architecture.
- Add Telegram interactive inline keyboard approval and question buttons.
- Add mobile and tablet responsive layout for dashboard.
- Add fail-closed routing and session disambiguation for slash commands.
- Add HttpOnly session authentication and token sanitization for dashboard.
- Add interactive setup wizard and interactive uninstaller.
- Add Traditional Chinese and English bilingual support.

## 0.1.0 - 2026-08-19

- Wire OpenCode plugin notifications to broker-managed Telegram delivery and reply polling.
- Fix OpenCode plugin loading by keeping the plugin entrypoint default-export only.
- Fix detached broker startup when OpenCode is hosted by a non-`bun` executable.
- Suppress benign broker client shutdown rejections during plugin disposal.
- Record GitNexus release readiness
- Add npm release verification
- Add security and protocol documentation
- Document Telegram notifier operations
- Add broker container image contract
- Add setup and doctor coverage
- Add broker doctor diagnostics
- Add broker lifecycle commands
- Validate Telegram notifier configuration
- Add guided Telegram setup
- Add Telegram reply routing isolation tests
- Add Telegram interaction outcome feedback
- Keep permission replies terminal-only
- Reply to OpenCode questions from Telegram
- Continue completed sessions from Telegram replies
- Validate Telegram interaction bindings
- Persist Telegram message bindings
- Add Telegram contract fixtures
- Add Telegram notification renderer
- Initial Telegram notifier implementation
