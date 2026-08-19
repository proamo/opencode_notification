# Data Retention

The notifier stores only local operational state required for routing, delivery, idempotency, and diagnostics. State lives in the current user's state directory and is never uploaded to this project or to a hosted relay.

## Stored Data

| Location | Contents | Sensitive notes |
|---|---|---|
| `machine-id` | Stable UUID for this user/computer state. | Not a hardware identifier. |
| `broker-secret` | Local bearer secret for broker authentication. | Secret; keep file private. |
| `route-salt` | Secret HMAC key for project ID derivation. | Secret; deleting it changes project IDs. |
| `telegram-bot-token` | Optional setup-created bot token file. | Secret; not stored in SQLite. |
| `broker.json` | Port, pid, nonce, protocol, start timestamp. | Informational only; authenticated probing is authoritative. |
| `state.sqlite` `meta` | Schema version, machine ID, Telegram update offset, pinned bot ID. | Does not contain bot token. |
| `state.sqlite` `message_routes` | Telegram chat/message ID, route key, action kind, interaction ID, status, timestamps. | Uses opaque project IDs; no raw reply text. |
| `state.sqlite` `callback_tokens` | Random callback tokens, action, optional bounded payload, binding timestamps. | Tokens are route capabilities until expiry. |
| `state.sqlite` `outbox` | Redacted Telegram payload JSON, delivery status, result code, priority, retry timestamps. | Payloads are sanitized and bounded but still may reveal notification text. |
| `state.sqlite` `inbound_updates` | Telegram update ID, disposition, action ID, optional payload hash, timestamp. | Does not store raw update payload. |
| `state.sqlite` `notification_dedupe` | Idempotency keys and expiry timestamps. | Used to suppress duplicate sends. |

## Not Stored

The implementation must not persist:

- Bot tokens in SQLite.
- Broker secrets in SQLite.
- Raw Telegram reply text.
- Full OpenCode transcripts.
- Source code, tool output, or file contents.
- Canonical project paths.
- Telegram updates that are not needed for idempotency beyond update ID, disposition, and optional hash.

## Default Retention

Default cleanup policy:

| Record type | Time retention | Count limit |
|---|---:|---:|
| Terminal message routes | 7 days | 10,000 |
| Terminal outbox records | 7 days | 10,000 |
| Inbound update records | 7 days | 50,000 |
| Callback tokens | Until expiry | 50,000 |
| Notification dedupe records | Until expiry | 50,000 |

Active message routes remain until they expire, are consumed, go offline, or are explicitly purged. The broker runs cleanup at startup and periodically during runtime.

## Expiry And Purge

Cleanup behavior:

- Active message routes become `expired` when their action TTL passes.
- Pending or retrying outbox records become `failed` when their delivery TTL passes.
- Terminal route, outbox, inbound update, callback token, and dedupe rows are deleted according to retention windows and count limits.
- Inspection returns schema version, machine ID, update offset, and aggregate counts only.

Manual purge:

```sh
opencode-telegram-broker stop
opencode-telegram-broker purge-state
```

`purge-state` removes message routes, callback tokens, outbox records, inbound updates, notification dedupe records, and the Telegram update offset. It preserves schema metadata and machine identity. It does not delete token files, broker secret, route salt, or the database file itself.

## Database Repair

The broker does not silently recreate a corrupt database. Explicit repair archives `state.sqlite` and WAL/SHM sidecars to timestamped `pre-repair` paths before creating a replacement. A healthy database is refused unless the caller intentionally requests a force reset.

Archive deletion is a user decision. Keep archives private because they may contain redacted notification payloads and route metadata.

## Uninstall Deletion

To fully remove local state, stop the broker and delete the state directory after any desired purge or archive backup:

```sh
opencode-telegram-broker stop
rm -rf ~/.local/state/opencode-telegram-link
```

Use the platform-specific state directory if `XDG_STATE_HOME`, macOS Application Support, Windows `LOCALAPPDATA`, or `OPENCODE_TELEGRAM_BROKER_STATE_DIR` changes the path.
