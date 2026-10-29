## ADDED Requirements

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

## MODIFIED Requirements

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

#### Scenario: Legacy wildcard config is loaded locally
- **WHEN** a local plugin reads `0.0.0.0` or `::` as the Broker bind value
- **THEN** it SHALL use the corresponding loopback client address rather than treating wildcard as a remote destination
