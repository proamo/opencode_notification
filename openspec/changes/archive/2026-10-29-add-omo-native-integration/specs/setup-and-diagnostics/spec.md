## ADDED Requirements

### Requirement: OMO extension installation
Setup SHALL offer to install the OMO Native extension when an OMO agent directory exists (`OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, or `~/.omo/agent`), copying the bundled extension and a setup-generated entry file so the extension does not depend on a package cache. Uninstall SHALL remove the extension directory only when its entry file matches the setup-generated entry, and MUST leave any other extension directory in place.

#### Scenario: OMO is detected during setup
- **WHEN** setup runs on a machine with an OMO agent directory and the user accepts the prompt
- **THEN** setup SHALL install the bundled extension and tell the user to restart OMO windows

#### Scenario: Uninstall finds a developer-installed extension
- **WHEN** the extension entry file differs from the setup-generated entry
- **THEN** uninstall MUST NOT remove the directory and SHALL report that it was left in place

### Requirement: Stale loopback plugin endpoint recovery
When a Gateway-role plugin's configured loopback Broker host is unreachable, the client SHALL read the current-user native deployment record and, if it names a different host on the same port where an authenticated Broker answers, SHALL connect to that host and emit a `BROKER_HOST_FROM_DEPLOYMENT` diagnostic. It MUST NOT spawn a competing Broker in that case.

#### Scenario: Gateway was moved to an overlay IP after plugin setup
- **WHEN** the plugin config names `127.0.0.1` but the native deployment record names a reachable private overlay IP on the same port
- **THEN** the plugin SHALL connect to the recorded host without spawning a Broker
