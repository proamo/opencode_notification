# Changelog

All notable changes to this project are documented here. Run `bun run release:changelog` before tagging a release.

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
