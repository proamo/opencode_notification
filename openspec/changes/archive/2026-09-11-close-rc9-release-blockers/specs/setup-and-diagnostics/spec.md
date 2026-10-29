## ADDED Requirements

### Requirement: Private lifecycle and deployment ownership
Local Broker configuration and administrator lifecycle commands SHALL use only loopback, wildcard, or private IP addresses and MUST reject public plaintext destinations before transmitting credentials. Gateway and Node role settings SHALL be mutually exclusive. Lifecycle commands SHALL use explicit flags or environment values first, then fill missing host and port values from current-user-only persisted Gateway state. Gateway doctor SHALL validate Telegram and administrator runtime state; Node doctor SHALL discover persisted/OpenCode Node configuration when notifier environment variables are absent, fail closed on the first applicable invalid config, validate Gateway reachability without requiring Telegram credentials, and MUST NOT transmit `gateway-secret` as an administrator credential. Setup SHALL refuse to overwrite Gateway-owned state with a Node marker, MUST NOT print credentials in manual snippets, and SHALL create private backups of credential-bearing config. Docker setup SHALL persist the exact Compose file/project and mount the selected host state directory. Uninstall MUST manage systemd and native Broker resources only for a native Gateway deployment, the persisted Compose project only for its Docker deployment, and no Gateway data or resources for a Node deployment; markerless uninstall SHALL require explicit mode selection and Docker shutdown MUST be verified before state cleanup.

#### Scenario: Custom endpoint is persisted
- **WHEN** status, stop, purge guard, or doctor omits host or port and private setup state contains it
- **THEN** the lifecycle operation SHALL use the persisted value, with explicit values overriding individual fields

#### Scenario: Administrator target is public plaintext HTTP
- **WHEN** local plugin startup or a lifecycle operation targets a public IP without an HTTPS administrator control plane
- **THEN** it MUST reject the operation before transmitting `broker-secret`, `gateway-secret`, or bot credentials

#### Scenario: Doctor runs on a Node Agent
- **WHEN** valid Node configuration contains a Gateway URL and `gateway-secret`
- **THEN** doctor SHALL check unauthenticated Gateway reachability without requiring a bot token, local `broker-secret`, or Telegram API access

#### Scenario: Node Agent is uninstalled beside a native Gateway
- **WHEN** Node deployment state is uninstalled on a host that also has a native Gateway service
- **THEN** uninstall MUST NOT stop or remove that systemd service, Gateway process, database, bot token, credentials, or shared state directory

#### Scenario: Node setup targets Gateway-owned state
- **WHEN** Node setup finds a native or Docker ownership marker in its selected state directory
- **THEN** setup MUST fail without replacing the marker and SHALL require a separate Node state directory

#### Scenario: Node setup targets markerless Gateway state
- **WHEN** Node setup finds Gateway credentials, token, configuration, or database files without an ownership marker
- **THEN** setup MUST fail without creating a Node marker and SHALL require a separate Node state directory

#### Scenario: Docker deployment is uninstalled after package movement
- **WHEN** Docker setup state identifies its Compose file and project directory
- **THEN** uninstall SHALL use only that project, run shutdown, verify no project containers remain, and preserve state if ownership or shutdown cannot be confirmed

#### Scenario: Docker setup uses a non-default state root
- **WHEN** setup selects Docker with an explicit state directory or `XDG_STATE_HOME`
- **THEN** the Compose deployment SHALL mount that exact directory at `/state`

#### Scenario: Setup prints manual Node configuration
- **WHEN** the user declines automatic Node config injection
- **THEN** stdout SHALL contain a credential placeholder and MUST NOT contain `gateway-secret`

#### Scenario: Existing notifier configuration is invalid
- **WHEN** doctor or plugin resolution receives explicit non-undefined options or finds an applicable tuple, map, or legacy-root notifier entry that is missing or fails schema validation
- **THEN** resolution SHALL fail closed and MUST NOT hide it behind a later global or persisted fallback

#### Scenario: Doctor applies non-credential environment overrides
- **WHEN** discovered configuration is valid and locale or endpoint port environment overrides are present
- **THEN** doctor SHALL apply those overrides without replacing the discovered deployment role and credentials

#### Scenario: Gateway configuration migrates to Node
- **WHEN** setup updates a Gateway plugin entry to Node role
- **THEN** it SHALL remove both Telegram and voice credentials plus unsupported legacy plugin keys before writing schema-valid Node options

#### Scenario: Credential-bearing config is backed up
- **WHEN** setup migration or uninstall creates an `opencode.json.bak`
- **THEN** the backup SHALL allow current-user access only

#### Scenario: Legacy uninstall has no ownership marker
- **WHEN** uninstall finds no valid deployment marker, even if a Gateway systemd unit exists on the host
- **THEN** it SHALL require explicit native, Docker, or Node selection before operating resources

#### Scenario: Systemd restart exits without a live unit
- **WHEN** installation restarts the Gateway unit but `systemctl is-active` reports inactive
- **THEN** setup SHALL report failure and restore the previous bundle and unit instead of claiming success

#### Scenario: Stale plugin requests a competing native endpoint
- **WHEN** persisted native deployment ownership identifies a managed Gateway endpoint and a detached client requests another bind host or port
- **THEN** Broker startup MUST fail before binding or polling Telegram; Node ownership and host-side Docker startup MUST be rejected, while the explicitly marked container process MAY start the Docker Broker

#### Scenario: Native deployment records ownership
- **WHEN** native setup persists deployment ownership
- **THEN** the marker SHALL include the owned bind host and port so service startup remains authoritative without relying on a separate notifier config; legacy mode-only state SHALL use a valid private persisted endpoint or require migration

#### Scenario: Deployment ownership marker is a dangling symlink
- **WHEN** Broker startup encounters a deployment marker path that is not a private current-user regular file
- **THEN** startup MUST fail closed and MUST NOT treat the state as markerless legacy state
