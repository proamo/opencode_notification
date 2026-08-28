# setup-and-diagnostics Specification

## Purpose
Defines guided setup, credential handling, local broker lifecycle controls, diagnostics, and documentation needed to operate the V1 notifier safely.
## Requirements
### Requirement: Guided user-owned bot setup
Setup SHALL guide the user through configuring a user-owned Telegram bot, identifying the allowed Telegram user and chat, selecting a supported locale, and validating local notifier configuration. It MUST NOT require a vendor account, hosted relay, shared bot, or telemetry enrollment.

#### Scenario: User completes valid setup
- **WHEN** the user supplies a valid bot credential, allowed user identity, allowed chat identity, and supported configuration
- **THEN** setup SHALL validate the values and report that the notifier is ready for a test notification

#### Scenario: Required setup value is missing
- **WHEN** a required credential or allowed identity is absent
- **THEN** setup MUST fail closed and SHALL identify the missing category without printing secret values

### Requirement: Credential confidentiality
Bot credentials and local broker authentication secrets SHALL be accepted only through documented secret-capable configuration sources, SHALL be stored with platform-appropriate current-user-only access when persisted, and MUST be redacted from logs, diagnostics, errors, process arguments, notifications, and exported non-secret configuration. The system MUST NOT transmit credentials anywhere except the Telegram API endpoint they authenticate or the local component they secure.

#### Scenario: Credential is persisted
- **WHEN** setup stores a bot credential or broker authentication secret
- **THEN** the credential SHALL be stored in the documented secret location with access restricted to the current user

#### Scenario: Diagnostic output is requested
- **WHEN** setup or doctor reports configuration and connectivity details
- **THEN** all credentials and authentication headers MUST be omitted or irreversibly redacted

#### Scenario: Secret storage permissions are unsafe
- **WHEN** a persisted secret is readable by unauthorized local users
- **THEN** setup and doctor MUST report an actionable error and the notifier MUST NOT start with that secret

### Requirement: Configuration validation
Setup and startup SHALL validate credential presence, allowed identities, locale, event filters, redaction configuration, debounce and expiry bounds, broker endpoint locality, and mutually incompatible settings before enabling delivery or interaction. Unknown or unsafe security-sensitive values MUST fail closed.

#### Scenario: Configuration is valid
- **WHEN** all required values and bounds are valid
- **THEN** validation SHALL succeed without exposing credentials

#### Scenario: Broker endpoint is non-local
- **WHEN** configuration points the V1 broker at a non-loopback network endpoint
- **THEN** validation MUST fail and SHALL explain that V1 requires a local-only broker

#### Scenario: Locale is unsupported
- **WHEN** configuration specifies an unsupported locale
- **THEN** validation SHALL report the unsupported value and the notifier SHALL use the documented English fallback only when fallback is permitted by configuration validation policy

### Requirement: Broker lifecycle commands
The product SHALL provide documented, user-invoked means to start, stop, and inspect the local broker. Starting SHALL preserve singleton polling ownership, stopping SHALL not terminate OpenCode sessions, and status SHALL distinguish running, stopped, unhealthy, and unreachable states.

#### Scenario: User starts a stopped broker
- **WHEN** valid setup exists and the user invokes the documented start operation
- **THEN** one local broker SHALL start and expose healthy local status

#### Scenario: User starts an already running broker
- **WHEN** a healthy broker already owns polling and the user invokes start
- **THEN** the operation SHALL report the existing broker without starting a second poller

#### Scenario: User stops the broker
- **WHEN** the user invokes the documented stop operation
- **THEN** Telegram polling and remote interaction SHALL stop without terminating connected OpenCode sessions

### Requirement: Single-container Broker deployment
The product SHALL provide an optional single-container image for the Broker. The image SHALL run without an embedded OpenCode process, SHALL persist Broker state in one documented volume, SHALL accept secrets without baking them into the image, and SHALL require host-loopback-only port publication. Native local mode SHALL remain the default installation.

#### Scenario: User starts the documented container configuration
- **WHEN** the user provides a persistent state volume, required secrets, and a `127.0.0.1` host port mapping
- **THEN** one Broker container SHALL serve multiple OpenCode plugins on that computer without a hosted relay

#### Scenario: Container is recreated with the same state volume
- **WHEN** the Broker container is replaced while retaining its documented state volume
- **THEN** machine identity, routing state, update offset, and idempotency state SHALL remain available

#### Scenario: Image contains configured credentials
- **WHEN** the distributable image is inspected
- **THEN** it MUST NOT contain a user bot token, Broker secret, chat identity, or generated machine identity

### Requirement: Doctor diagnostics
The product SHALL provide a doctor operation that checks configuration validity, secret-file permissions, broker singleton and reachability, loopback-only binding, Telegram credential validity and API reachability, allowed identity configuration, plugin-to-broker registration, catalog availability, and supported OpenCode compatibility. Each check SHALL return a sanitized pass, warning, or failure with an actionable remediation.

#### Scenario: Installation is healthy
- **WHEN** doctor runs against a correctly configured and connected installation
- **THEN** all required checks SHALL pass without exposing credentials or session content

#### Scenario: Multiple pollers or non-loopback binding is detected
- **WHEN** doctor detects competing polling ownership or a broker exposed beyond loopback
- **THEN** it MUST report a security failure and SHALL provide remediation that restores one local-only broker

#### Scenario: OpenCode compatibility cannot be established
- **WHEN** installed OpenCode event or SDK behavior is outside the supported compatibility range
- **THEN** doctor SHALL report the notifier as incompatible or unverified and MUST NOT report full readiness

### Requirement: Test notification
Setup SHALL provide an explicit test-notification operation that sends a localized, non-actionable message only after configuration, credential, authorization target, broker, and Telegram connectivity checks pass. The test MUST contain no session content and MUST NOT create a routable session interaction.

#### Scenario: Test prerequisites pass
- **WHEN** the user requests a test and all prerequisite checks pass
- **THEN** the allowed chat SHALL receive a localized message clearly labeled as a test

#### Scenario: Test prerequisite fails
- **WHEN** credentials, target identity, broker health, or Telegram connectivity validation fails
- **THEN** no test message SHALL be attempted and setup SHALL return a sanitized actionable error

#### Scenario: User replies to a test message
- **WHEN** the user replies to the test notification
- **THEN** the reply MUST NOT be routed to any OpenCode session

### Requirement: Safe diagnostic data
Logs and diagnostic reports SHALL default to metadata required for troubleshooting and MUST exclude bot credentials, broker secrets, Telegram message text, prompts, answers, question content, transcripts, source code, tool output, and unredacted file paths or environment values. Any optional verbose diagnostic mode MUST preserve the same secret and content exclusions.

#### Scenario: Delivery failure is logged
- **WHEN** Telegram delivery fails
- **THEN** diagnostics SHALL include sanitized failure classification and timing but MUST omit authorization headers and notification content

#### Scenario: Interaction routing fails
- **WHEN** a Telegram interaction cannot be routed
- **THEN** diagnostics SHALL identify the failed validation stage using opaque or redacted identifiers without recording reply text

### Requirement: Documented V1 limitations and privacy boundaries
English documentation SHALL explicitly state that V1 supports one computer, one local broker, and one user-owned bot; does not support multi-computer routing, a hosted relay, remote permission decisions, offline command queues, complete conversation mirroring, telemetry, or guaranteed notification delivery; and sends selected metadata through Telegram subject to Telegram's service. A Traditional Chinese overview SHALL communicate the same scope, security boundaries, and non-goals without contradicting the English canonical documentation.

#### Scenario: User reviews English V1 documentation
- **WHEN** the user reads setup or limitations documentation
- **THEN** it SHALL describe all V1 topology, privacy, delivery, and interaction limitations before the user enables the notifier

#### Scenario: User reviews Traditional Chinese overview
- **WHEN** the user reads the Traditional Chinese overview
- **THEN** it SHALL identify English documentation as canonical and SHALL accurately summarize the same single-computer and privacy boundaries

### Requirement: Uninstall and credential rotation guidance
Documentation SHALL explain how to stop the broker, disable the plugin, remove local route state and secrets, revoke or rotate the Telegram bot credential, and verify that polling has ceased. Rotation MUST invalidate use of the prior credential after the configured credential is replaced and the broker is restarted.

#### Scenario: User rotates a bot credential
- **WHEN** the user follows the documented rotation procedure
- **THEN** the restarted broker SHALL authenticate only with the replacement credential and doctor SHALL validate the replacement without displaying it

#### Scenario: User uninstalls the notifier
- **WHEN** the user follows the documented uninstall procedure
- **THEN** the broker SHALL no longer poll or accept local registrations and the documentation SHALL identify all user-owned state that can be removed

### Requirement: Interactive setup wizard and deployment mode selection
The product SHALL provide an interactive setup wizard (`setup`) that supports language selection, deployment mode selection (Native vs Docker Container), real-time Telegram Bot token verification, Nonce-based pairing, OpenCode configuration auto-injection with backup creation, and automated Docker container orchestration.

#### Scenario: User runs interactive setup with Native mode
- **WHEN** the user executes the interactive setup wizard and chooses Native mode
- **THEN** the wizard SHALL verify the bot token, complete chat pairing, save the token file with secure permissions, inject plugin configuration into `opencode.json` with a `.bak` backup, and offer to send a test notification

#### Scenario: User runs interactive setup with Docker mode
- **WHEN** the user executes the interactive setup wizard and chooses Docker mode
- **THEN** the wizard SHALL complete pairing, write configuration, and provide an option to automatically build and start the Docker Broker container in the background via Docker Compose

### Requirement: Interactive uninstaller and automated cleanup
The product SHALL provide a 1-command interactive uninstaller (`uninstall`) that safely shuts down active broker processes (native process and Docker containers), removes plugin configuration from discovered `opencode.json` files while preserving non-notifier settings, purges SQLite operational routing databases, and deletes private token files and state directories upon confirmation.

#### Scenario: User executes interactive uninstallation
- **WHEN** the user invokes the uninstaller wizard and confirms the cleanup steps
- **THEN** any active native broker or Docker Broker container SHALL be terminated, `opencode-telegram-link` configuration SHALL be removed from `opencode.json`, operational SQLite databases SHALL be purged, and the private token file and state directory SHALL be removed

### Requirement: Multi-Engine Voice Configuration and Extended Retention
Configuration validation SHALL support optional `voice` configuration properties (`enabled`, `provider`, `apiKey`, `apiKeyFile`, `model`, `endpoint`, `language`) supporting providers including Groq, OpenAI, and custom OpenAI-compatible endpoints. The system SHALL support session prompt replay TTL configurations up to 365 days with a 30-day default.

#### Scenario: User configures Groq Whisper speech provider
- **WHEN** the user specifies `voice: { provider: "groq", apiKey: "gsk_..." }`
- **THEN** the configuration SHALL validate successfully and the broker SHALL initialize Groq Whisper STT processing

#### Scenario: User configures Cloudflare Workers AI speech provider
- **WHEN** the user specifies `voice: { provider: "cloudflare", apiKey: "cfut_...", accountId: "2fa0..." }`
- **THEN** the configuration SHALL validate successfully and the broker SHALL route STT requests to Cloudflare Workers AI

#### Scenario: User configures extended retention
- **WHEN** the user configures `interaction: { sessionPromptTtlMinutes: 43200 }`
- **THEN** validation SHALL accept the 30-day window without exceeding maximum bounds



