# local-instance-routing Specification

## Purpose
Defines the Hub-and-Spoke Gateway & Node Agent broker topology and the exact, fail-closed routing contract across concurrent OpenCode processes, projects, sessions, and multi-host nodes.
## Requirements
### Requirement: Multi-Host Hub-and-Spoke Topology
V2 SHALL support a Central Gateway and multiple Node Agents sharing one user-owned Telegram bot. The Central Gateway SHALL be the singleton Telegram polling owner. Node Agents SHALL establish authenticated outbound WebSocket connections to the Central Gateway and register their distinct `machineId`, `instanceId`, and `hostLabel`.

#### Scenario: Multiple local and remote Node Agents connect
- **WHEN** multiple OpenCode instances on local and remote machines connect to the configured Gateway
- **THEN** they SHALL share the Gateway's single Telegram bot without polling collisions (`409 Conflict`)

#### Scenario: Inbound command routed across machines
- **WHEN** an authorized Telegram reply or button interaction is received for a remote Node Agent's route
- **THEN** the Central Gateway SHALL forward the command to the exact WebSocket connection matching the target `machineId` and `route`

### Requirement: Host-local and Remote Broker Access
The Gateway SHALL require Bearer token authentication for all WebSocket connections. Local connections SHALL default to loopback, while remote Node Agents MAY connect over LAN, VPN (e.g. Tailscale), or reverse proxy using secure WebSocket (`ws://` or `wss://`).

#### Scenario: Authenticated Node Agent connects
- **WHEN** a Node Agent on a remote machine presents a valid Gateway authentication token
- **THEN** the Gateway SHALL permit connection registration and attach the node's `hostLabel` to registered routes

#### Scenario: Unauthenticated client connects
- **WHEN** a client attempts connection without valid authentication
- **THEN** the Gateway MUST reject the WebSocket upgrade immediately

### Requirement: Singleton polling ownership
At most one broker process on the computer SHALL own Telegram update polling for the configured bot at a time. Concurrent startup attempts MUST converge on the existing healthy broker or fail visibly without starting a second poller.

#### Scenario: Broker is already healthy
- **WHEN** another OpenCode process starts the notifier
- **THEN** it SHALL connect to the existing broker rather than start another Telegram poller

#### Scenario: Concurrent singleton acquisition occurs
- **WHEN** two processes attempt to become broker owner concurrently
- **THEN** no more than one process SHALL acquire polling ownership

### Requirement: Exact composite route identity and session hot fallback
Every routable registration and actionable notification SHALL be bound to the composite identity of machine, OpenCode instance, project, session, and route generation. For session continuation prompts (`session.prompt`), the broker SHALL prioritize exact route matching, and when the exact generation is superseded, SHALL hot-fallback match by `(machineId, projectId, sessionId)` to deliver prompts to the currently active live connection of that exact session. The broker MUST NOT cross machine boundaries or project boundaries.

#### Scenario: All route components match one live registration
- **WHEN** an authorized command contains machine, instance, project, and session identities that exactly match one live registration
- **THEN** the broker SHALL forward the command only to that registration

#### Scenario: Route generation superseded after reconnect for same session
- **WHEN** an authorized session prompt refers to an earlier connection generation for an active `(machineId, projectId, sessionId)`
- **THEN** the broker SHALL hot-forward the prompt to the currently active live registration of that session

#### Scenario: Machine, project, or session differs
- **WHEN** any one of machine, project, or session identity differs from active registrations
- **THEN** the broker MUST reject the route as offline without cross-project or cross-machine fallback

#### Scenario: Human-readable labels collide
- **WHEN** two registrations have identical project or session display labels but different composite identities
- **THEN** the broker SHALL keep their routes distinct

### Requirement: Instance and project identity lifecycle
Each running OpenCode process SHALL use an instance identity that is unique among concurrent processes, and each project registration SHALL use a stable project identity independent of its display label. Restarting a process MUST create or restore identities according to documented persistence rules without silently reassigning an old live route to a different process or project.

#### Scenario: Same project is open in two processes
- **WHEN** two OpenCode processes concurrently open the same project
- **THEN** their distinct instance identities SHALL prevent commands for one process from reaching the other

#### Scenario: Project label changes
- **WHEN** a project display label changes while its stable project identity remains the same
- **THEN** route matching SHALL continue to use the stable project identity

### Requirement: Registration freshness
The broker SHALL track whether each instance and session route is currently live using registration lifecycle and bounded freshness information. A stale, disconnected, superseded, or explicitly unregistered route MUST be treated as offline.

#### Scenario: Plugin disconnects cleanly
- **WHEN** a plugin unregisters or its connection closes
- **THEN** its routes SHALL become unavailable for new commands

#### Scenario: Plugin disappears without unregistering
- **WHEN** a registration exceeds its freshness interval without renewal
- **THEN** the broker SHALL mark the registration offline and MUST NOT forward commands to it

### Requirement: Offline commands are not queued
V1 MUST NOT queue, defer, replay, or reroute Telegram commands for an offline OpenCode instance or unavailable session. It SHALL return localized feedback that the target is unavailable and that the user must retry after receiving a new actionable notification.

#### Scenario: Target instance is offline
- **WHEN** an otherwise valid Telegram command targets an offline instance
- **THEN** the broker MUST reject the command, MUST NOT persist it for later execution, and SHALL send localized unavailability feedback

#### Scenario: Target reconnects later
- **WHEN** a previously rejected target reconnects
- **THEN** the broker MUST NOT replay the rejected command

### Requirement: Route state privacy and integrity
Persisted route state SHALL contain only the minimum identifiers and status needed for local routing, SHALL be protected from access by other local users using platform-appropriate permissions, and MUST NOT contain bot credentials, complete conversations, source code, tool output, or secrets. Corrupt, ambiguous, or unverifiable route state MUST fail closed.

#### Scenario: Route state is persisted
- **WHEN** the broker stores route state needed across its own restart
- **THEN** the stored state SHALL omit credentials and session content and SHALL be restricted to the current user

#### Scenario: Persisted route state is invalid
- **WHEN** the broker reads corrupt, duplicate, or unverifiable route state
- **THEN** it MUST refuse routing through that state and SHALL expose a sanitized diagnostic

### Requirement: Broker lifecycle failure behavior
Loss or restart of the broker MUST NOT interrupt the underlying OpenCode session. Plugins SHALL report notifier unavailability locally, SHALL attempt bounded reconnection, and MUST NOT represent undelivered notifications as delivered.

#### Scenario: Broker stops during an OpenCode session
- **WHEN** the local broker becomes unavailable
- **THEN** OpenCode work SHALL continue while notifier delivery and remote interaction are reported as unavailable

#### Scenario: Broker restarts
- **WHEN** the broker becomes available after a restart
- **THEN** live plugins SHALL re-register their current routes before those routes accept commands

