## 1. Gateway Runtime and Credentials

- [x] 1.1 Restore Telegram daemon configuration from private state and keep polling active without WebSocket clients
- [x] 1.2 Expose active, degraded, and unconfigured Telegram runtime states without idle shutdown masking failures
- [x] 1.3 Separate `broker-secret` administrator scope from `gateway-secret` Node scope
- [x] 1.4 Add atomic RC.8 identity classification, private query-token migration, and Node credential rotation
- [x] 1.5 Require administrator proof before accepting Telegram runtime configuration
- [x] 1.6 Wait for in-flight Telegram delivery during Broker shutdown

## 2. Network and Client Connectivity

- [x] 2.1 Default native binding to loopback and validate explicit interface IPs
- [x] 2.2 Permit plaintext WebSocket only for loopback/private destinations and require WSS for public hosts
- [x] 2.3 Send WebSocket credentials in Authorization headers
- [x] 2.4 Make local client probe, spawn, and WebSocket connection use the configured Broker interface address
- [x] 2.5 Add wildcard exposure confirmation and sanitized doctor diagnostics

## 3. Setup, Service, and Cleanup

- [x] 3.1 Persist private Gateway config and native, Docker, or Node deployment markers atomically
- [x] 3.2 Migrate exact notifier config entries to tuple-array schema while preserving nested options
- [x] 3.3 Install a stable systemd bundle with explicit bind address and restart-on-failure policy
- [x] 3.4 Roll back prior systemd unit, bundle, and enablement state when upgrade activation fails
- [x] 3.5 Use container-valid token paths for Docker daemon state
- [x] 3.6 Make Docker, systemd, and state uninstall fail closed with bounded subprocess execution
- [x] 3.7 Store Dashboard settings privately and reject symlinked or non-regular settings files

## 4. Verification and Documentation

- [x] 4.1 Add regression tests for daemon lifecycle, degraded polling, scoped authentication, and RC.8 migration
- [x] 4.2 Add regression tests for network policy, configured-host clients, config migration, and private file permissions
- [x] 4.3 Add regression tests for systemd rollback, Docker isolation, and fail-closed uninstall
- [x] 4.4 Update English and Traditional Chinese setup, security, protocol, retention, and release documentation
- [x] 4.5 Run type checks, full tests, build, release smoke, npm pack dry-run, systemd verification, and live ZeroTier Telegram validation
