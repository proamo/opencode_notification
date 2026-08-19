# Compatibility Policy

The initial implementation targets the following contract range:

| Component | Supported range | CI coverage |
|---|---|---|
| Bun | `>=1.3.0` | Minimum `1.3.0` and current development `1.3.14` |
| `@opencode-ai/plugin` | `>=1.18.0 <2` | Minimum `1.18.0` and current development `1.18.18` |
| Local protocol | Major `1` | Current minor plus capability negotiation |
| Telegram Bot API | HTTPS Bot API used by the user's bot | Contract fixtures; no credentials in CI |

An OpenCode release is considered interaction-compatible only after fixtures confirm its event payloads and integration tests confirm the session prompt and question reply APIs. Unknown event shapes and unverified remote interaction APIs fail closed.

Patch releases may add tested OpenCode versions without changing the local protocol. A breaking wire change requires a new protocol major and a coordinated restart of local OpenCode processes.

## Runtime Requirements

The package targets Bun because the broker uses `bun:sqlite`, Bun WebSocket support, `fetch`, and Web Crypto APIs. It does not install a background service or postinstall hook.

Native broker mode requires the configured port to be available on loopback. Docker broker mode requires a host port published to `127.0.0.1`, a persistent state volume, and runtime-mounted secrets.

## Compatibility Checks

Compatibility is checked at several layers:

- Package metadata declares the supported Bun engine and `@opencode-ai/plugin` peer range.
- TypeScript and test fixtures validate supported OpenCode event payloads and SDK calls.
- Plugin registration includes package version, OpenCode version, protocol version, capabilities, machine ID, instance ID, and configuration fingerprint.
- Broker registration rejects missing required capabilities, mismatched machine IDs, incompatible configuration fingerprints, and conflicting instance ownership.
- Doctor reports unsupported OpenCode versions, missing runtime capabilities, Telegram polling conflicts, and broker singleton conflicts as actionable diagnostics.

## Upgrade Policy

Compatible patch upgrades should preserve protocol major `1` and SQLite schema compatibility. Existing brokers may continue to serve newer plugins only when negotiation succeeds.

Incompatible upgrades must fail closed. The user should stop the broker, update the package, restart OpenCode processes, and run `opencode-telegram-broker doctor` before relying on remote replies.

SQLite schema migrations are transactional. If a database exists and the schema is older than the current implementation, the broker creates a pre-migration backup before migrating. If the database schema is newer than supported, startup fails rather than attempting a downgrade.
