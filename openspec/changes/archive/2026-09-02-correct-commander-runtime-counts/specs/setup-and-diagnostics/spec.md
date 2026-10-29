## ADDED Requirements

### Requirement: Configured endpoint lifecycle control
Broker status, start reuse, stop, purge guards, doctor, and uninstall SHALL probe and control the configured Gateway bind host and port rather than assuming loopback defaults. Wildcard server binds SHALL normalize to loopback for local control requests, and IPv6 addresses SHALL use valid URL authority syntax. Uninstall SHALL read the private persisted endpoint and MUST fail closed when a present endpoint record is invalid or shutdown cannot be confirmed.

#### Scenario: Gateway uses an explicit overlay interface
- **WHEN** lifecycle or doctor runs with an explicit private interface address and port
- **THEN** it SHALL probe, report, and control that endpoint rather than `127.0.0.1:42617`

#### Scenario: Native uninstall uses persisted endpoint
- **WHEN** private Gateway state records a valid non-loopback host or non-default port
- **THEN** uninstall SHALL confirm and stop that endpoint before deleting configuration, credentials, or state

#### Scenario: Persisted endpoint is invalid
- **WHEN** the private endpoint record exists but its host or port is missing or invalid
- **THEN** uninstall MUST return failure and preserve configuration, credentials, and state

#### Scenario: Gateway binds a wildcard or IPv6 address
- **WHEN** a local lifecycle client targets `0.0.0.0`, `::`, or an explicit IPv6 address
- **THEN** it SHALL normalize wildcard destinations to loopback and construct a valid bracketed IPv6 URL
