## Why

RC.8 made the Gateway network-accessible and attempted standalone Telegram polling, but it coupled Node and administrator credentials, defaulted to wildcard exposure, depended on transient package-cache paths, and could stop or degrade incorrectly when no OpenCode client was attached. RC.9 must make the already-supported multi-host topology safe and operational for continuous use without introducing a hosted relay or expanding the single-user trust model.

## What Changes

- Keep the persisted Telegram runtime active without WebSocket clients and report terminal poller failures as degraded.
- Restore daemon Telegram configuration exclusively from private Gateway state in native and Docker deployments.
- Default native Gateways to loopback, support explicit overlay interface addresses, and require WSS for public hosts.
- Separate administrator and Node credentials, authenticate new WebSocket clients by header, and provide bounded RC.8 migration plus Node credential rotation.
- Restrict Telegram runtime configuration to clients that prove administrator authority.
- Migrate exact OpenCode plugin entries to tuple-array schema while preserving nested notifier options and credentials.
- Install a stable systemd bundle and make setup, upgrades, Docker cleanup, systemd cleanup, and uninstall fail closed.
- Persist Dashboard settings and setup state atomically with current-user-only permissions.
- **BREAKING**: Node Agents must use `gateway-secret`; `broker-secret` is reserved for Dashboard and control APIs. Public Gateway URLs must use `wss://`.

V1/RC.9 remains a self-hosted, single-user system with one user-owned Telegram bot and no hosted relay, telemetry, offline command queue, arbitrary remote shell execution, or cross-user routing. Selected metadata still traverses Telegram under Telegram's service terms.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `setup-and-diagnostics`: Secure persisted setup, service lifecycle, deployment markers, diagnostics, uninstall, and recovery behavior.
- `local-instance-routing`: Overlay/public transport policy, scoped credentials, migration compatibility, and continuous singleton Gateway ownership.
- `telegram-session-interaction`: Continuous command polling and degraded-state behavior when no OpenCode route is connected.

## Impact

Affected areas include broker authentication and lifecycle, plugin WebSocket transport, persisted identity, setup and config migration, systemd and Docker deployment, uninstall, doctor output, Dashboard settings, documentation, and release artifacts. Existing RC.8 state remains migratable; rotating `gateway-secret` ends legacy query-token compatibility and requires Node configuration updates.
