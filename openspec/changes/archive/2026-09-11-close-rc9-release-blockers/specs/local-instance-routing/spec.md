## ADDED Requirements

### Requirement: Cross-machine stable identity and active fallback
Stable plugin instance identity SHALL include machine identity, process identity, and the filesystem-canonical project directory. Exact route generations MAY remain routable while inactive for authorized continuation. Stale-generation fallback MUST select only an active route matching machine, instance, project, and session. Busy or terminal events received before session metadata SHALL establish placeholders with the observed activity state.

#### Scenario: Matching process and path exist on two Nodes
- **WHEN** two machines run the same PID and canonical project path
- **THEN** their plugin instance identities SHALL remain distinct

#### Scenario: Project is opened through a symlink alias
- **WHEN** one process initializes the same project through real and symlink paths
- **THEN** both initializations SHALL derive the same instance identity

#### Scenario: Stale generation points to an inactive route
- **WHEN** a command has no exact generation and the matching composite route is inactive
- **THEN** hot fallback MUST reject the route as offline

#### Scenario: Terminal event precedes metadata
- **WHEN** idle or error arrives before session metadata
- **THEN** the route SHALL remain exactly routable but SHALL be marked inactive

#### Scenario: Busy event precedes metadata
- **WHEN** busy status arrives before session metadata
- **THEN** the route SHALL be marked active and later metadata SHALL preserve that activity state

#### Scenario: Completion is in flight during deletion
- **WHEN** session deletion occurs while completion summary retrieval is pending
- **THEN** the pending completion SHALL be dropped and MUST NOT recreate session state or routing

#### Scenario: Stale busy event follows deletion
- **WHEN** a busy status for a session arrives after its deletion tombstone
- **THEN** the event SHALL be dropped and MUST NOT recreate an active route

#### Scenario: Route registration is in flight during deletion
- **WHEN** route deletion occurs while a replacement route registration is awaiting acknowledgement
- **THEN** the acknowledged generation SHALL be immediately unregistered and MUST NOT reappear as the active route

#### Scenario: Rotated Gateway authenticates from loopback
- **WHEN** `gateway-secret` differs from `broker-secret`
- **THEN** `/v1/connect` MUST reject query-string credentials even from loopback and SHALL require the authorization header

#### Scenario: Managed private Broker restarts
- **WHEN** a local plugin cannot reach a configured non-loopback private Broker endpoint
- **THEN** it SHALL retry the managed endpoint through the startup timeout and MUST NOT spawn a competing Broker or Telegram poller

#### Scenario: Local wildcard Broker auto-starts
- **WHEN** local plugin configuration uses `0.0.0.0` or `::` and no Broker is running
- **THEN** the plugin SHALL connect through loopback while preserving the configured wildcard as the spawned Broker bind address

#### Scenario: User cancels an inactive session
- **WHEN** `/cancel` or Dashboard cancel targets a routable but inactive session
- **THEN** cancellation SHALL report the session offline and MUST NOT dispatch, while `/run` continuation MAY still resolve that route
