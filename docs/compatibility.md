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
