## ADDED Requirements

### Requirement: Continuous Gateway command polling
The configured Central Gateway SHALL continue Telegram update polling and slash-command processing while no OpenCode plugin or route is connected. Commands requiring an unavailable route SHALL return localized unavailability feedback; Gateway-level commands such as `/help` and `/status` SHALL remain available.

#### Scenario: User requests status with no connected Node
- **WHEN** an authorized user sends `/status` while the Gateway has no WebSocket clients
- **THEN** the Gateway SHALL reply with current runtime and zero-connection status

#### Scenario: User dispatches to an unavailable route
- **WHEN** an authorized command requires a Node route that is offline
- **THEN** the Gateway MUST NOT queue or reroute the command and SHALL return localized unavailability feedback

### Requirement: Telegram runtime health states
The Gateway SHALL expose Telegram runtime as `active`, `degraded`, or `unconfigured`. Terminal polling failures SHALL transition to `degraded` without terminating the Gateway or erasing the failure state. A trusted local registration or service restart MAY restore the runtime after the cause is resolved.

#### Scenario: Poller exits after authorization failure
- **WHEN** Telegram rejects the configured bot credential with a terminal error
- **THEN** runtime health SHALL become `degraded` and diagnostics SHALL identify a sanitized polling failure

#### Scenario: No Telegram identity is persisted
- **WHEN** the Gateway starts without complete Telegram configuration
- **THEN** runtime health SHALL be `unconfigured` while authenticated Node routing remains available

### Requirement: Administrator-authorized runtime configuration
Telegram bot identity and runtime settings SHALL be loaded from private Gateway state or supplied by a plugin proving `broker-secret` authority. Source IP alone MUST NOT authorize runtime configuration, including when a public Node arrives through a loopback reverse proxy. Node-only credentials MUST NOT replace bot identity, authorization targets, locale, voice credentials, or interaction policy.

#### Scenario: Trusted local plugin registers
- **WHEN** a local plugin provides valid administrator proof and a valid Telegram runtime configuration
- **THEN** the Gateway MAY initialize or recover the runtime from that configuration

#### Scenario: Node behind local reverse proxy registers
- **WHEN** a remote Node appears to originate from loopback but possesses only `gateway-secret`
- **THEN** the Gateway MUST NOT apply its Telegram runtime payload
