## Context

RC.9 supports a Central Gateway on loopback or a private overlay. Administrator HTTP endpoints use `broker-secret` and do not provide native HTTPS. Node Agents use a separate `gateway-secret` over WS/WSS. Final review identified places where these credential and deployment boundaries were not consistently enforced.

## Goals / Non-Goals

**Goals:**

- Keep instance ownership unique across machines, processes, and canonical projects.
- Permit exact inactive continuation while preventing stale-generation fallback to inactive routes.
- Ensure administrator lifecycle traffic never sends credentials to a public plaintext address.
- Diagnose and uninstall only resources owned by the configured deployment role.

**Non-Goals:**

- Add an HTTPS administrator API or remote administrator credential distribution.
- Stop a Central Gateway while uninstalling a Node Agent.
- Change exact route authorization or remove idle continuation routes.

## Decisions

### Bind stable identity to machine state

The deterministic UUID hashes machine ID, PID, and filesystem-canonical project path. Machine state prevents cross-node collisions; `realpath` collapses symlink aliases; PID keeps separate OpenCode processes distinct.

### Split exact resolution from active fallback

An exact route generation remains routable even when inactive so an authorized continuation can target it. A stale generation may fallback only to an active route matching machine, instance, project, and session.

### Resolve local administrator endpoints from private state

Lifecycle flags and environment values override individual persisted host/port values. Missing values come from the current-user-only setup record. Public IPs are rejected because the local administrator API is HTTP-only; wildcard binds normalize to loopback for local requests.

### Make diagnostics and cleanup role-aware

Gateway doctor validates bot credentials and administrator status. Node doctor sends no secret in an unauthenticated HTTP(S) reachability probe and accepts the expected 401. Native uninstall may manage systemd and native Broker state; Docker uninstall manages its compose deployment; Node uninstall manages only local plugin configuration and state.

## Risks / Trade-offs

- [Public interface lifecycle commands stop working] -> This is intentional until an authenticated HTTPS administrator control plane exists.
- [Malformed persisted state blocks lifecycle cleanup] -> Fail closed and preserve state instead of targeting defaults.
- [Reordered terminal event lacks title metadata] -> Register an inactive placeholder route so notification routing remains exact without claiming active work.

## Migration Plan

No data migration is required. Rebuild and restart the Gateway and OpenCode clients. Existing RC.8 routes without activity metadata remain active-compatible until their clients reconnect.
