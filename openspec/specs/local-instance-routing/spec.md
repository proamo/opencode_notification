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

### Requirement: Scoped Gateway credentials
The Central Gateway SHALL maintain separate administrator and Node credentials. Administrator APIs SHALL require `broker-secret`; WebSocket Node registration SHALL require `gateway-secret`. Possession of only `gateway-secret` MUST NOT authorize health details, settings, dispatch, stop, credential rotation, or Telegram runtime configuration.

#### Scenario: Node credential accesses WebSocket endpoint
- **WHEN** a Node presents the valid `gateway-secret` in an Authorization header
- **THEN** the Gateway SHALL allow WebSocket registration subject to protocol validation

#### Scenario: Node credential accesses administrator API
- **WHEN** a requester presents only `gateway-secret` to a Dashboard or control endpoint
- **THEN** the Gateway MUST reject the request

#### Scenario: Remote Node attempts Telegram runtime injection
- **WHEN** a Node registration includes Telegram runtime configuration without valid administrator proof
- **THEN** the Gateway MUST ignore the payload when a trusted runtime is active or reject registration when no trusted runtime exists

### Requirement: Bounded RC.8 credential migration
On first startup with an existing RC.8 `broker-secret` and no identity-version marker, the Gateway SHALL initialize `gateway-secret` from the legacy secret to preserve private-source Node connectivity. Legacy URL query credentials SHALL be accepted only from loopback or private source addresses while both credentials remain equal. Rotating `gateway-secret` and restarting MUST permanently disable query-token migration and prior Node credentials.

#### Scenario: Existing RC.8 private Node reconnects
- **WHEN** a migrated private Node presents the legacy query credential before rotation
- **THEN** the Gateway SHALL accept the connection without granting broader privileges than the matching administrator credential already had in RC.8

#### Scenario: Administrator rotates Node credential
- **WHEN** `gateway-secret` is rotated and the Gateway restarts
- **THEN** the old query credential and old Node Authorization credential MUST be rejected

#### Scenario: Concurrent fresh identity initialization
- **WHEN** multiple fresh processes initialize state concurrently
- **THEN** they SHALL converge on one administrator credential and one distinct Node credential

### Requirement: Host-local and Remote Broker Access
The Gateway SHALL default native binding to loopback and SHALL support explicit private LAN or overlay interface binding for authenticated multi-host access. Plain `ws://` SHALL be allowed only for loopback and private address ranges. Public IP and DNS endpoints MUST use `wss://` through a TLS reverse proxy. New clients SHALL transmit credentials in Authorization headers, not URL query strings.

#### Scenario: Authenticated private Node Agent connects
- **WHEN** a remote Node reaches an explicit private overlay address using `ws://` and presents valid `gateway-secret`
- **THEN** the Gateway SHALL permit registration and attach the Node's identity to its routes

#### Scenario: Authenticated Node Agent connects
- **WHEN** a Node Agent reaches an allowed loopback, private-overlay, or public-WSS endpoint and presents valid `gateway-secret`
- **THEN** the Gateway SHALL permit protocol registration and bind its `hostLabel` to registered routes

#### Scenario: Public Node uses secure WebSocket
- **WHEN** a Node uses a public `wss://` Gateway endpoint with valid Node credentials
- **THEN** transport validation SHALL accept the endpoint

#### Scenario: Public Node uses plaintext WebSocket
- **WHEN** a Node configures a public IP or DNS endpoint using `ws://`
- **THEN** validation MUST reject the endpoint before transmitting credentials

#### Scenario: Unauthenticated client connects
- **WHEN** a client attempts WebSocket upgrade without valid Node authentication
- **THEN** the Gateway MUST reject the upgrade immediately

### Requirement: Singleton polling ownership
Exactly one active Central Gateway SHALL own Telegram update polling for the configured bot across local and remote Nodes. The Gateway SHALL restore its runtime from private persisted state and SHALL not transfer polling ownership to plugins. Concurrent startup attempts MUST converge on the existing healthy Gateway or fail visibly. Connected plugins MAY provide runtime configuration only with administrator proof and MUST NOT start independent pollers.

#### Scenario: Service starts before OpenCode
- **WHEN** valid persisted Telegram state exists and no plugin is connected
- **THEN** the Central Gateway SHALL start one poller and remain the owner as plugins later connect

#### Scenario: Broker is already healthy
- **WHEN** another OpenCode process starts while the configured Gateway is healthy
- **THEN** it SHALL connect to the existing Gateway rather than start another Telegram poller

#### Scenario: Concurrent singleton acquisition occurs
- **WHEN** concurrent processes attempt to start the same configured Gateway endpoint
- **THEN** at most one SHALL acquire the listener and Telegram polling ownership while others converge or fail visibly

#### Scenario: Multiple plugins connect concurrently
- **WHEN** local and remote OpenCode plugins register with the active Gateway
- **THEN** they SHALL share the existing poller without creating Telegram `409 Conflict`

#### Scenario: Competing broker owns the bot
- **WHEN** Telegram terminates polling because another `getUpdates` owner exists
- **THEN** the Gateway SHALL report degraded status rather than silently starting repeated independent pollers

### Requirement: Exact composite route identity and session hot fallback
Every routable registration and actionable notification SHALL be bound to the composite identity of machine, OpenCode instance, project, session, and route generation. For session continuation prompts (`session.prompt`), the broker SHALL prioritize exact route matching, and when the exact generation is superseded, SHALL hot-fallback match by `(machineId, instanceId, projectId, sessionId)` to deliver prompts to the currently active live connection of that exact session. The broker MUST NOT cross machine, instance, or project boundaries.

#### Scenario: All route components match one live registration
- **WHEN** an authorized command contains machine, instance, project, and session identities that exactly match one live registration
- **THEN** the broker SHALL forward the command only to that registration

#### Scenario: Route generation superseded after reconnect for same session
- **WHEN** an authorized session prompt refers to an earlier connection generation for an active `(machineId, instanceId, projectId, sessionId)`
- **THEN** the broker SHALL hot-forward the prompt to the currently active live registration of that session

#### Scenario: Machine, project, or session differs
- **WHEN** any one of machine, instance, project, or session identity differs from active registrations
- **THEN** the broker MUST reject the route as offline without cross-instance, cross-project, or cross-machine fallback

#### Scenario: Human-readable labels collide
- **WHEN** two registrations have identical project or session display labels but different composite identities
- **THEN** the broker SHALL keep their routes distinct

### Requirement: Fail-closed session resolution and disambiguation
When resolving sessions by Session ID or prefix for slash commands (`/cancel`, `/run`), the resolver SHALL prioritize exact session matches and support prefix matches of at least 6 characters. If multiple matches exist across different instances, projects, or distinct sessions, the resolver MUST fail closed and return an ambiguous status. The system SHALL inform the user and MUST NOT dispatch commands to an arbitrary matching instance.

#### Scenario: Unique session or prefix match
- **WHEN** an authorized command specifies a session ID or prefix that uniquely matches one live session
- **THEN** the resolver SHALL return the unique route for command dispatch

#### Scenario: Duplicate or colliding session identifiers across instances
- **WHEN** an authorized command specifies a session ID or prefix that matches sessions across multiple instances or projects
- **THEN** the resolver MUST report the target as ambiguous, return localized corrective guidance, and MUST NOT dispatch the command

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
Loss or restart of the Gateway MUST NOT interrupt underlying OpenCode sessions. Plugins SHALL report notifier unavailability, retry connection with bounded backoff, and re-register live routes after recovery. A local plugin SHALL connect to the configured Broker interface address; wildcard bind values SHALL normalize to an appropriate loopback client address. Failed notifier delivery MUST NOT be represented as delivered.

#### Scenario: Gateway stops during an OpenCode session
- **WHEN** the Gateway becomes unavailable
- **THEN** OpenCode work SHALL continue while notifier and remote interaction are reported unavailable

#### Scenario: Broker stops during an OpenCode session
- **WHEN** the configured Gateway stops while OpenCode work remains active
- **THEN** OpenCode work SHALL continue and the plugin SHALL report notifier unavailability without claiming delivery

#### Scenario: Broker restarts
- **WHEN** the configured Gateway returns after restart
- **THEN** live plugins SHALL reconnect and re-register their current routes before those routes accept commands

#### Scenario: Gateway restarts on an explicit overlay address
- **WHEN** the configured Gateway becomes available after restart
- **THEN** local and remote plugins SHALL reconnect to that configured address and re-register current routes

### Requirement: Logical connection and activity accounting
One OpenCode process SHALL expose at most one registered notifier instance per canonical project directory, even when OpenCode invokes the configured plugin factory multiple times. Different processes or project directories SHALL retain distinct instance identities. Route availability and execution activity SHALL be tracked separately: inactive routes MUST remain available for exact authorized continuation but MUST NOT appear in Commander or `/sessions` active counts.

#### Scenario: Plugin factory is invoked repeatedly
- **WHEN** one OpenCode process initializes the notifier more than once for the same project directory
- **THEN** all invocations SHALL use the same instance identity, exactly one SHALL own the registered connection, and duplicate initialization SHALL fail closed without duplicating routes or notifications

#### Scenario: Separate OpenCode windows use the same project
- **WHEN** two OpenCode processes initialize the same project directory
- **THEN** each process SHALL receive a distinct instance identity and MAY own one connection

#### Scenario: Session becomes busy
- **WHEN** the plugin observes `session.status=busy` for a routable session
- **THEN** the route SHALL be marked active and SHALL appear once in active-session views

#### Scenario: Session becomes idle
- **WHEN** the plugin observes `session.idle` or a terminal session error
- **THEN** the route SHALL be marked inactive and removed from active-session views while exact authorized continuation routing remains available

#### Scenario: Legacy client omits activity metadata
- **WHEN** an authenticated pre-RC.9 client registers a route without an activity field
- **THEN** the Gateway SHALL treat the route as active for mixed-version compatibility

#### Scenario: Legacy wildcard config is loaded locally
- **WHEN** a local plugin reads `0.0.0.0` or `::` as the Broker bind value
- **THEN** it SHALL use the corresponding loopback client address rather than treating wildcard as a remote destination

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

### Requirement: Remote Command Dispatch (session.spawn and session.cancel)
The broker protocol SHALL support `session.spawn` and `session.cancel` command types alongside `session.prompt`, `question.reply`, and `permission.reply`. The target plugin SHALL handle session creation via OpenCode SDK APIs and session abort/cancel operations.

#### Scenario: session.spawn command received
- **WHEN** a connected OpenCode plugin receives a valid `session.spawn` command with title and initial prompt
- **THEN** the plugin SHALL invoke OpenCode session creation, submit the initial prompt, and return the new session ID

#### Scenario: session.cancel command received
- **WHEN** a connected OpenCode plugin receives a valid `session.cancel` command for an active session
- **THEN** the plugin SHALL invoke OpenCode session abort/stop APIs and return accepted status

### Requirement: In-place route activity updates
A client SHALL be able to change an owned route's active state by re-registering the same route generation. The Gateway SHALL update the activity flag without replacing the generation, so message bindings created for earlier notifications of that session remain routable.

#### Scenario: Session goes idle after a question notification
- **WHEN** a client marks a session route inactive after a question notification was sent for it
- **THEN** the question's message binding SHALL still resolve to the same route generation
