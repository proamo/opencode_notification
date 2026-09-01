# Local Broker Protocol

The local broker protocol connects OpenCode plugin instances to one broker process on the same computer. The broker owns Telegram polling and durable message bindings; plugins own live OpenCode state and SDK calls.

## Version

Current version: protocol major `1`, minor `0`.

Compatibility rules:

- Major version mismatch is incompatible and must fail closed.
- Minor version is forward-compatible only when both sides negotiate required capabilities.
- Current broker capabilities are `route-registration` and `heartbeat`.

## Transport

Native mode listens on `127.0.0.1:42617` by default. Container mode binds inside the container to `0.0.0.0`, but the Docker port must be published to `127.0.0.1` on the host.

HTTP endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/health` | `GET` | Authenticated broker discovery and machine/protocol check. |
| `/v1/status` | `GET` | Authenticated diagnostics for bind host, connection count, and route count. |
| `/v1/connect` | WebSocket upgrade | Authenticated plugin protocol connection. |
| `/v1/control/stop` | `POST` | Authenticated graceful broker stop. |

Every endpoint requires `Authorization: Bearer <brokerSecret>`. The broker compares SHA-256 digests with constant-time comparison and does not accept credentials in URLs.

## State Identity

The state directory contains:

| File | Purpose |
|---|---|
| `machine-id` | Stable UUID for this computer/user state. |
| `broker-secret` | Local bearer secret shared by plugins and broker. |
| `route-salt` | Secret HMAC key used to derive opaque project IDs. |
| `broker.json` | Informational discovery record with port, pid, nonce, protocol, and start time. |
| `state.sqlite` | Durable route, delivery, update offset, and idempotency state. |

On non-Windows platforms, state files must be owned by the current user and must not allow group or other access.

## Envelope

All WebSocket messages are JSON envelopes with these common fields:

| Field | Meaning |
|---|---|
| `protocol` | `{ major, minor }`, currently `{ "major": 1, "minor": 0 }`. |
| `requestId` | UUID for request/response correlation. |
| `sentAt` | ISO timestamp with offset. |
| `type` | Discriminator for the envelope type. |
| `payload` | Type-specific validated object. |

Maximum frame size is `256 KiB`. Frames above that limit, invalid JSON, or schema-invalid messages are rejected and the connection is closed with a policy or payload-size code.

## Client To Broker Messages

`register` starts a connection:

```json
{
  "type": "register",
  "payload": {
    "packageVersion": "1.0.0-rc.7",
    "openCodeVersion": "1.18.x",
    "machineId": "uuid",
    "instanceId": "uuid",
    "configFingerprint": "sha256-hex",
    "capabilities": ["route-registration", "heartbeat"]
  }
}
```

The broker rejects registration when the machine ID differs, a required capability is missing, the instance is already owned by another connection, or the active broker configuration fingerprint differs from the first registered plugin.

`route.register` binds a live OpenCode route to the registered connection:

```json
{
  "type": "route.register",
  "payload": {
    "route": {
      "machineId": "uuid",
      "instanceId": "uuid",
      "projectId": "opaque-hmac-id",
      "sessionId": "opencode-session-id",
      "routeGeneration": "uuid"
    },
    "projectLabel": "redacted-display-label",
    "sessionLabel": "redacted-display-label"
  }
}
```

`route.unregister` removes a route owned by the same connection. `heartbeat` updates connection liveness. `command.result` returns the result for a broker command and must echo the expected `commandId`.

## Broker To Client Messages

The broker replies with:

| Type | Purpose |
|---|---|
| `registered` | Confirms connection registration and negotiated capabilities. |
| `route.registered` | Confirms route ownership. |
| `route.unregistered` | Confirms route removal. |
| `heartbeat.ack` | Confirms heartbeat receipt. |
| `command` | Sends a session prompt or question answer command to the owning plugin. |
| `error` | Sends a sanitized protocol error. |

Commands:

- `session.prompt`: contains `commandId`, exact `route`, and text up to `16 KiB`.
- `question.reply`: contains `commandId`, exact `route`, `interactionId`, and bounded answer arrays.

Command results are `accepted`, `rejected`, `stale`, or `indeterminate`. The broker treats missing, mismatched, timed-out, or disconnected command results as stale or indeterminate and provides Telegram feedback instead of retrying forever.

## Routing Invariants

Route ownership requires all route key fields to match:

- `machineId`
- `instanceId`
- `projectId`
- `sessionId`
- `routeGeneration`

When a plugin re-registers a newer route for the same machine, instance, project, and session, the older generation is replaced. When the WebSocket closes, every route owned by that connection is removed immediately. Persisted Telegram message bindings are actionable only while their route is active, unexpired, and live in the registry.

## Telegram Interaction Flow

1. The broker sends a Telegram notification from a redacted outbox payload.
2. If delivery succeeds, it stores the Telegram `chatId`/`messageId` to route binding and optional callback tokens.
3. The poller reads updates sequentially from the committed Telegram offset.
4. The authorizer rejects updates outside the pinned private user/chat.
5. The validator requires a direct reply or callback token bound to the original bot message.
6. The broker verifies route freshness and dispatches the typed command to the owning plugin.
7. The plugin revalidates live OpenCode state, calls the supported OpenCode API, and returns a command result.
8. The broker records the update disposition, advances the offset, and sends localized Telegram feedback when needed.
