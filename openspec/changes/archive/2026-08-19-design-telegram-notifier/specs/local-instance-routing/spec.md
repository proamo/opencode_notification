## Purpose

Defines the single-computer broker topology and the exact, fail-closed routing contract across concurrent OpenCode processes, projects, and sessions.

## ADDED Requirements

### Requirement: Single-computer V1 topology
V1 SHALL support exactly one local broker and one user-owned Telegram bot per configured computer, serving multiple OpenCode processes, projects, and sessions on that computer. V1 MUST NOT claim or attempt routing between computers, and MUST NOT depend on a hosted relay, shared service, account system, or telemetry service.

#### Scenario: Multiple local OpenCode processes connect
- **WHEN** multiple OpenCode processes on the same computer use the configured notifier
- **THEN** they SHALL share the computer's single local broker and bot polling owner

#### Scenario: Route names another computer
- **WHEN** an inbound command refers to a machine identity other than the local configured machine
- **THEN** the broker MUST reject it without forwarding or cross-machine discovery

### Requirement: Host-local broker access
The broker SHALL be reachable only from the same computer and MUST reject unauthenticated clients. A native Broker SHALL listen only on loopback. A containerized Broker MAY listen on its container interface only when its container port is published exclusively to host loopback; it MUST NOT be published on all host interfaces, a LAN address, or a public address.

#### Scenario: Local authenticated plugin connects
- **WHEN** a plugin on the same computer presents valid local broker authentication
- **THEN** the broker SHALL permit registration

#### Scenario: Remote or unauthenticated client connects
- **WHEN** a client connects through a non-local interface or lacks valid local broker authentication
- **THEN** the broker MUST reject the request without disclosing route state

#### Scenario: Container port is published to host loopback
- **WHEN** the single-container Broker maps its container port exclusively to `127.0.0.1` on the host and the plugin authenticates
- **THEN** the deployment SHALL be treated as local-only and SHALL support the same routing contract as native mode

#### Scenario: Container port is published on all host interfaces
- **WHEN** Docker configuration publishes the Broker port through `0.0.0.0`, an unspecified host address, or a non-loopback host address
- **THEN** setup and diagnostics MUST report an unsafe deployment and MUST NOT report the notifier as ready

### Requirement: Singleton polling ownership
At most one broker process on the computer SHALL own Telegram update polling for the configured bot at a time. Concurrent startup attempts MUST converge on the existing healthy broker or fail visibly without starting a second poller.

#### Scenario: Broker is already healthy
- **WHEN** another OpenCode process starts the notifier
- **THEN** it SHALL connect to the existing broker rather than start another Telegram poller

#### Scenario: Concurrent singleton acquisition occurs
- **WHEN** two processes attempt to become broker owner concurrently
- **THEN** no more than one process SHALL acquire polling ownership

### Requirement: Exact composite route identity
Every routable registration and actionable notification SHALL be bound to the exact composite identity of machine, OpenCode instance, project, and session. The broker MUST match all four components exactly and MUST NOT route by project path, display label, session title, Telegram chat, or session identifier alone.

#### Scenario: All route components match one live registration
- **WHEN** an authorized command contains machine, instance, project, and session identities that exactly match one live registration
- **THEN** the broker SHALL forward the command only to that registration

#### Scenario: One route component differs
- **WHEN** any one of machine, instance, project, or session identity differs from the live registration
- **THEN** the broker MUST reject the route and MUST NOT fall back to a partial match

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
