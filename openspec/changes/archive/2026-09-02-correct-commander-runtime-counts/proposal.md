## Why

OpenCode can invoke one configured plugin factory multiple times inside a single process, while RC.8 assigned a fresh instance identity to every invocation. Commander therefore showed two to four connections per VS Code window and counted every routable idle or completed session as active, creating duplicate cards and stale activity totals.

## What Changes

- Derive one logical plugin instance identity from the OpenCode process and project directory so duplicate factory invocations fail closed at the existing ownership boundary.
- Keep idle sessions routable for exact continuation while recording activity separately from route availability.
- Mark routes active on `session.status=busy` and inactive on `session.idle` or terminal error.
- Show only active routes in Commander and active-session listings while preserving all exact routing lookups.
- Make lifecycle commands, doctor, and uninstall use the configured or persisted Gateway bind host and port.

The single-user, self-hosted privacy boundary is unchanged. This adds no hosted relay, telemetry, multi-user authorization, offline command queue, or new session-content storage.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-instance-routing`: Logical connection uniqueness, route activity semantics, and configured-endpoint lifecycle control.
- `setup-and-diagnostics`: Persisted-endpoint doctor and fail-closed uninstall behavior.

## Impact

Affected areas include plugin instance identity, route registration metadata, OpenCode event bridging, Commander summaries, `/sessions`, Broker lifecycle commands, doctor, uninstall, protocol declarations, tests, generated artifacts, and operational documentation. The new route activity field is optional so mixed RC.8 clients remain visible as active until upgraded.
