## Context

See `proposal.md` for motivation. RC.8 already exposed a multi-host Gateway and persisted Telegram identity, but runtime ownership, authentication scopes, package-cache service paths, and migration behavior crossed trust boundaries. RC.9 must preserve existing state and active Node connectivity while moving to least privilege and deterministic service ownership.

## Goals / Non-Goals

**Goals:**

- Keep one continuously available Telegram poller owned by the Central Gateway.
- Make loopback, private overlay, and public WSS deployments explicit and testable.
- Separate Node connectivity from administrator control without breaking first migration startup.
- Make setup, systemd upgrade, Docker state, settings persistence, and uninstall atomic or fail closed.
- Preserve exact composite routing for session prompts, question replies, and permission replies.

**Non-Goals:**

- Hosted relay, multi-user roles, public plaintext transport, offline command queues, or arbitrary shell execution.
- Automatic distribution of rotated Node credentials.
- Trusting reverse-proxy source addresses as proof of local administrator authority.

## Decisions

### Persist the Gateway runtime independently of plugins

The service loads `opencode-notifier.json` and `telegram-identity.json` only from its private state directory and starts the Telegram runtime before any WebSocket registration. Client count no longer controls daemon lifetime when a runtime is configured. Terminal poller errors clear active ownership but leave the Broker running in a degraded state.

Alternative considered: let the first plugin own polling. This preserves RC.8 coupling, creates startup races, and cannot provide 24/7 slash commands.

### Split administrator and Node credentials

`broker-secret` protects Dashboard, settings, dispatch, stop, and other control APIs. `gateway-secret` protects `/v1/connect`. Local plugins submit a separate administrator proof header before the Broker accepts Telegram runtime configuration; network locality alone is insufficient because a same-host reverse proxy makes remote traffic appear loopback.

For RC.8 state, an atomic identity-mode marker classifies the installation before creating credentials. Legacy state initially copies the administrator credential into `gateway-secret`; fresh state generates distinct values. Rotation writes a new Node credential atomically and ends query-token compatibility after restart.

Alternative considered: continue sharing one credential. This lets every Node control the Gateway and makes safe rotation impossible.

### Classify transport by destination

Native setup defaults to `127.0.0.1`. Explicit loopback and private/overlay IPs may use plaintext WebSocket because the network itself supplies the private transport boundary. Public IPs and DNS names require WSS. Wildcard binding requires explicit confirmation and operational firewall or reverse-proxy controls. Local clients connect to the configured interface address, with wildcard values normalized to loopback.

Alternative considered: permit `ws://` for all user-entered hosts. This sends credentials over observable public networks and permits hostname-prefix bypasses.

### Install stable and recoverable service artifacts

Systemd runs a private copied bundle under the state directory rather than an npx cache path. Installation prepares the bundle and unit before restart, records previous service enablement, and restores prior artifacts if activation fails. Docker daemon configuration uses `/state` paths while host OpenCode config retains host paths.

Alternative considered: execute directly from the package-manager cache. Cache eviction or package cleanup would break the boot service.

### Persist private JSON atomically

Setup state, Dashboard settings, deployment markers, and credentials use same-directory temporary files, current-user-only modes, regular-file checks, and atomic rename. OpenCode config migration uses the supported tuple-array schema, exact specifier matching, deep option preservation, and a backup.

### Fail closed during uninstall

Deployment markers select native, Docker, or Node cleanup. Markerless RC.8 state requires explicit selection. Docker inspection/down and systemd disable/remove/reload have bounded execution and checked exit status. State deletion occurs only after the applicable runtime is confirmed stopped.

## Risks / Trade-offs

- [Legacy migration temporarily leaves both credentials equal] → Restrict URL-query compatibility to private sources and document immediate Node credential rotation after Nodes are updated.
- [Binding one overlay address means local clients cannot assume loopback] → Persist and use the configured Broker address consistently for probe, spawn, and WebSocket connection.
- [Reverse proxies collapse network source identity] → Require cryptographic administrator proof for runtime configuration instead of trusting loopback.
- [A terminal Telegram `409` can leave the runtime degraded] → Surface the state through status and doctor; eliminate competing local pollers and restart or re-register only after ownership is restored.
- [Rollback itself can fail] → Report rollback failure explicitly and preserve state for manual recovery rather than claiming success.

## Migration Plan

1. Build and verify RC.9 while RC.8 continues running.
2. Persist or migrate identity state; generate the atomic identity-mode marker and `gateway-secret`.
3. Install the stable bundle and systemd unit with the chosen loopback or overlay bind address.
4. Restart the Gateway and verify authenticated status, Telegram runtime, slash commands, and reply routing.
5. Restart OpenCode clients so they load tuple-array config and the configured Broker host.
6. Update remote Nodes with `gateway-secret`, rotate it, and restart the Gateway to disable RC.8 query compatibility.

Rollback restores the prior unit and stable bundle when service activation fails. Before credential rotation, RC.8 private Node connections remain compatible; after rotation, rollback requires distributing the current Node credential rather than re-enabling URL tokens.
