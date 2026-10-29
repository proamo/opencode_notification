## ADDED Requirements

### Requirement: Stable native service installation and upgrade
Native setup SHALL install a private, stable Broker bundle outside transient package-manager caches. The systemd unit SHALL use the configured explicit bind address, restart only after failures, and start after network availability. An upgrade MUST restart the service only after the replacement unit and bundle are ready, and a failed restart MUST restore the prior unit, bundle, and enablement state or report rollback failure.

#### Scenario: Native setup succeeds
- **WHEN** the user approves systemd installation and all privileged operations succeed
- **THEN** systemd SHALL run the stable private bundle with the configured bind address and SHALL enable it for boot

#### Scenario: Upgraded service fails to restart
- **WHEN** a replacement bundle or unit cannot start
- **THEN** installation MUST restore the prior service artifacts and state, attempt to resume the prior service, and return a non-zero result

### Requirement: Schema-safe OpenCode configuration migration
Setup SHALL migrate exact known notifier plugin specifiers to the supported tuple-array schema while preserving unrelated plugins and all supported nested notifier options. It MUST NOT match or remove packages merely because their names contain a notifier substring. Files containing credentials SHALL be replaced atomically with current-user-only permissions.

#### Scenario: Legacy notifier entry is migrated
- **WHEN** configuration contains a known package name or local notifier file URL in object or array form
- **THEN** setup SHALL produce one notifier tuple containing the merged supported options and configured Broker address

#### Scenario: Similar third-party package exists
- **WHEN** configuration contains a package such as `acme-telegram-link-audit`
- **THEN** migration MUST preserve that package unchanged

### Requirement: Deployment-aware fail-closed uninstall
Uninstall SHALL use the persisted native, Docker, or Node deployment marker to select cleanup operations. A legacy markerless installation SHALL require explicit deployment selection. It MUST NOT delete credentials or state unless the applicable Broker, systemd service, or Docker resources have been confirmed stopped and cleanup commands succeeded.

#### Scenario: Docker inspection or shutdown fails
- **WHEN** a Docker deployment cannot be inspected or `docker compose down` fails or times out
- **THEN** uninstall MUST return failure and MUST preserve credentials and state

#### Scenario: Native systemd cleanup fails
- **WHEN** systemd cannot disable, stop, remove, or reload the Gateway unit
- **THEN** uninstall MUST return failure without claiming successful removal or deleting private state

## MODIFIED Requirements

### Requirement: Credential confidentiality
Bot credentials, the administrator `broker-secret`, and the Node `gateway-secret` SHALL be accepted only through documented secret-capable sources, SHALL be stored with current-user-only access, and MUST be redacted from logs, diagnostics, errors, process arguments, notifications, and exported non-secret configuration. `broker-secret` MUST protect Dashboard and control APIs and MUST NOT be distributed to Node Agents. `gateway-secret` SHALL authenticate Node WebSocket connections and SHALL NOT grant administrator API access. The system MUST NOT transmit credentials except to the component they authenticate.

#### Scenario: Credential is persisted
- **WHEN** setup stores a bot, administrator, or Node credential
- **THEN** each credential SHALL be stored in its documented private file using atomic replacement

#### Scenario: Diagnostic output is requested
- **WHEN** setup or doctor reports configuration and connectivity details
- **THEN** all credentials and authentication headers MUST be omitted or irreversibly redacted

#### Scenario: Secret storage permissions are unsafe
- **WHEN** a persisted secret is readable by unauthorized local users or a secret path is a symlink or non-regular file
- **THEN** setup and doctor MUST report an actionable error and the notifier MUST NOT start with that secret

### Requirement: Configuration validation
Setup and startup SHALL validate credential presence, allowed identities, locale, filters, redaction, expiry bounds, Broker bind addresses, Gateway URLs, and mutually incompatible settings before enabling delivery or interaction. Native setup SHALL default to loopback. Explicit private LAN or overlay IPs MAY use `ws://`; public IP or DNS Gateway URLs MUST use `wss://`; wildcard native binding MUST require an explicit exposure confirmation. Unknown or unsafe security-sensitive values MUST fail closed.

#### Scenario: Configuration is valid
- **WHEN** all required values, bounds, credential scopes, and network transport rules are valid
- **THEN** validation SHALL succeed without exposing credentials

#### Scenario: Private overlay Gateway is configured
- **WHEN** a Gateway binds an explicit ZeroTier, NetBird, Tailscale, loopback, or other private interface IP and a Node uses `ws://`
- **THEN** validation SHALL accept the configuration

#### Scenario: Broker endpoint is non-local
- **WHEN** configuration points at a non-local private endpoint using `ws://` or a public endpoint using `wss://`
- **THEN** validation SHALL accept only the transport appropriate to that destination and MUST reject public plaintext transport

#### Scenario: Public Gateway uses plaintext WebSocket
- **WHEN** a Node configures a public IP or DNS Gateway URL using `ws://`
- **THEN** validation MUST fail and SHALL require `wss://`

#### Scenario: Locale is unsupported
- **WHEN** configuration specifies an unsupported locale
- **THEN** validation SHALL report the unsupported value and SHALL use English fallback only when permitted by policy

### Requirement: Broker lifecycle commands
The product SHALL provide documented means to start, stop, inspect, and diagnose the Gateway. A configured Gateway SHALL remain active and continue Telegram polling when no OpenCode WebSocket client is attached. Status SHALL distinguish active, degraded, unconfigured, stopped, unhealthy, and unreachable states. Stopping SHALL not terminate OpenCode sessions and SHALL wait for in-flight Telegram delivery before closing persistent state.

#### Scenario: Gateway has persisted Telegram configuration but no clients
- **WHEN** the service starts from private state and no OpenCode client is connected
- **THEN** one Telegram poller SHALL remain active and slash commands SHALL continue to work

#### Scenario: User starts a stopped broker
- **WHEN** valid setup exists and the user invokes the documented start operation
- **THEN** one Gateway SHALL start, restore configured Telegram state, and expose authenticated health

#### Scenario: User starts an already running broker
- **WHEN** a healthy Gateway already owns the configured endpoint and polling state and the user invokes start
- **THEN** the operation SHALL report the existing Gateway without starting a second poller

#### Scenario: User stops the broker
- **WHEN** the user invokes the documented stop operation
- **THEN** Telegram polling and remote interaction SHALL stop without terminating connected OpenCode sessions

#### Scenario: Telegram polling terminates permanently
- **WHEN** Telegram returns a terminal polling error
- **THEN** status SHALL report `degraded`, the daemon SHALL remain running for diagnosis, and idle shutdown MUST NOT hide the failure

#### Scenario: User stops the Gateway during delivery
- **WHEN** a Telegram delivery is in flight and stop is requested
- **THEN** the Gateway SHALL stop accepting new work, await the delivery result, and close state without creating a duplicate retry record

### Requirement: Doctor diagnostics
Doctor SHALL check configuration validity, private-file permissions, deployment and service state, singleton polling, configured bind address, transport security, Telegram credential validity, allowed identity, plugin registration, runtime state, and OpenCode compatibility. It SHALL accept documented private overlay binding, warn on wildcard exposure, fail public plaintext transport, and distinguish active, degraded, and unconfigured Telegram runtimes.

#### Scenario: Overlay installation is healthy
- **WHEN** doctor runs against a correctly configured Gateway bound to an explicit private overlay address
- **THEN** required checks SHALL pass without exposing credentials or session content

#### Scenario: Installation is healthy
- **WHEN** doctor runs against a correctly configured and connected loopback or private-overlay installation
- **THEN** all required checks SHALL pass without exposing credentials or session content

#### Scenario: Multiple pollers or non-loopback binding is detected
- **WHEN** doctor detects competing polling ownership or a non-loopback bind address
- **THEN** it SHALL fail competing polling, accept a documented explicit private-overlay bind, and warn or fail unsafe wildcard or public exposure

#### Scenario: OpenCode compatibility cannot be established
- **WHEN** installed OpenCode event or SDK behavior is outside the supported compatibility range
- **THEN** doctor SHALL report the notifier as incompatible or unverified and MUST NOT report full readiness

#### Scenario: Wildcard or public plaintext exposure is detected
- **WHEN** doctor detects wildcard binding without documented controls or a public `ws://` Gateway
- **THEN** it MUST report a security warning or failure with firewall or HTTPS/WSS reverse-proxy remediation

#### Scenario: Telegram runtime is degraded
- **WHEN** the persisted poller ended with a terminal error
- **THEN** doctor SHALL report degraded runtime health and MUST NOT report full readiness

### Requirement: Documented RC limitations and privacy boundaries
English and Traditional Chinese documentation SHALL describe the self-hosted Central Gateway and multi-host Node topology, single user-owned bot, credential scopes, loopback/private-overlay/public-WSS transport boundaries, Telegram metadata exposure, and operational migration steps. Documentation MUST state that the product provides no hosted relay, multi-user authorization, offline command queue, complete conversation mirroring, telemetry, arbitrary remote shell API, or guaranteed Telegram delivery.

#### Scenario: User reviews multi-host setup documentation
- **WHEN** the user configures a Central Gateway or Node Agent
- **THEN** documentation SHALL identify the correct bind address, `gateway-secret`, URL transport, and restart requirements without directing Nodes to use `broker-secret`

#### Scenario: User reviews privacy limitations
- **WHEN** the user reads either language overview
- **THEN** it SHALL accurately describe the same self-hosted trust boundary and Telegram service exposure

### Requirement: Interactive setup wizard and deployment mode selection
The interactive setup wizard SHALL support Gateway or Node role, native or Docker Gateway deployment, explicit native bind IP selection, bot verification, nonce pairing, private state persistence, deployment markers, schema-safe OpenCode configuration injection, and optional service startup. Node setup MUST require a valid Gateway URL and `gateway-secret`. Docker state SHALL use container-valid `/state` credential paths while host plugin configuration retains host-valid paths.

#### Scenario: User configures native overlay Gateway
- **WHEN** the user chooses native Gateway and supplies a valid overlay interface IP
- **THEN** setup SHALL persist that bind address, private Telegram state, separate credentials, a native deployment marker, and an OpenCode tuple configuration

#### Scenario: User runs interactive setup with Native mode
- **WHEN** the user chooses native Gateway, completes bot verification and pairing, and selects a valid bind IP
- **THEN** setup SHALL write private state, inject a backed-up tuple configuration, and offer stable systemd installation and a test notification

#### Scenario: User runs interactive setup with Docker mode
- **WHEN** the user chooses Docker Gateway and completes bot verification and pairing
- **THEN** setup SHALL write host and container-valid configuration and offer bounded Docker Compose startup

#### Scenario: User configures Docker Gateway
- **WHEN** the user chooses Docker and completes pairing
- **THEN** setup SHALL persist a Docker marker and daemon configuration whose token path resolves inside the mounted `/state` volume

#### Scenario: User configures Node without credential
- **WHEN** Node setup omits `gateway-secret`
- **THEN** setup MUST fail without writing a successful Node configuration
