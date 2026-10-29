## Why

Final RC.9 review found lifecycle and routing edge cases not covered by the initial Commander fix: plaintext administrator control could target public addresses, CLI defaults could miss a persisted custom endpoint, instance identities could collide across machines, and role-agnostic doctor/uninstall behavior could affect unrelated Gateways.

## What Changes

- Include machine identity and canonical project path in stable process-project instance IDs.
- Restrict stale-generation route fallback to active registrations with the full composite identity.
- Preserve inactive state when terminal events arrive before session metadata.
- Resolve lifecycle defaults from private persisted Gateway state and reject public plaintext administrator control.
- Make doctor and uninstall respect Gateway, Node, Docker, and native ownership boundaries.
- Correct Telegram active-route and idle-node rendering.

The self-hosted single-user privacy boundary is unchanged. This adds no hosted relay, telemetry, multi-user authorization, offline queue, or new session-content storage.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-instance-routing`: Cross-machine identity isolation, active-only hot fallback, and reordered terminal event semantics.
- `setup-and-diagnostics`: Persisted private lifecycle endpoints, role-aware diagnostics, and deployment-owned uninstall behavior.

## Impact

Affected code includes plugin identity derivation, route resolution, event bridging, Broker CLI endpoint resolution, doctor, uninstall, Telegram status rendering, tests, generated artifacts, specifications, and release documentation.
