# Changelog

All notable changes to this project are documented here. Run `bun run release:changelog` before tagging a release.

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
