## 1. Project Foundation

- [x] 1.1 Create the TypeScript/Bun package with plugin and broker entry points, strict compiler settings, linting, formatting, and test scripts
- [x] 1.2 Define the supported Bun and OpenCode version matrix and add CI jobs for all supported combinations
- [x] 1.3 Define typed configuration, normalized event, route, protocol envelope, command, result, and diagnostic schemas
- [x] 1.4 Add English and Traditional Chinese catalogs with compile-time key parity and locale canonicalization tests

## 2. Local Broker Protocol and Lifecycle

- [x] 2.1 Implement current-user state directory creation, broker secret generation, machine identity, and restrictive permission checks
- [x] 2.2 Implement the authenticated loopback WebSocket handshake, protocol negotiation, frame limits, schema validation, and heartbeats
- [x] 2.3 Implement singleton election through the deterministic exclusive port and concurrent candidate behavior
- [x] 2.4 Implement broker discovery, plugin auto-start, reconnect backoff, re-registration, idle shutdown, and graceful signal handling
- [x] 2.5 Add integration tests that start several plugin clients concurrently and prove that exactly one broker owns polling

## 3. Route State and Persistence

- [x] 3.1 Implement machine, instance, opaque project, session, and route-generation identities
- [x] 3.2 Implement the live connection registry and exact composite-route ownership checks
- [x] 3.3 Create the SQLite schema, transactional migrations, backup behavior, update offsets, message routes, outbox, and idempotency tables
- [x] 3.4 Implement TTL cleanup, bounded retention, state inspection, purge, and explicit corruption repair behavior
- [x] 3.5 Add routing tests for duplicate labels, identical projects in separate processes, stale generations, disconnects, and corrupt state

## 4. Telegram Transport and Notifications

- [x] 4.1 Implement Telegram Bot API calls, bot fingerprint validation, sequential long polling, committed offsets, and bounded retry handling
- [x] 4.2 Implement strict private-chat user/chat authorization, unauthorized-update rejection, and conflict shutdown on Telegram 409 responses
- [x] 4.3 Implement event normalization for completion, error, question, and permission events across supported OpenCode versions
- [x] 4.4 Implement root-session filtering, blocking subagent context, completion debounce, source-event deduplication, and bounded plugin buffering
- [x] 4.5 Implement allowlisted notification models, double redaction, HTML escaping, truncation, and safe plain-text fallback
- [x] 4.6 Add Telegram transport and notification contract tests using recorded API fixtures without real credentials

## 5. Remote Session Interaction

- [x] 5.1 Persist actionable Telegram message bindings and opaque one-time callback tokens after successful delivery
- [x] 5.2 Implement reply authorization, exact message binding, route freshness, state, action-kind, TTL, and idempotency validation
- [x] 5.3 Implement completed-session replies through the exact bound OpenCode session prompt API
- [x] 5.4 Implement constrained single- and multi-select and free-text answers through the exact pending OpenCode question reply API
- [x] 5.5 Implement non-actionable permission notices and localized terminal-intervention feedback for every attempted Telegram reply
- [x] 5.6 Implement accepted, rejected, expired, offline, invalid, stale, and indeterminate Telegram outcome feedback
- [x] 5.7 Add end-to-end tests with multiple fake OpenCode processes proving that replies never cross projects, instances, sessions, or interaction types

## 6. Setup and Operations

- [x] 6.1 Implement guided BotFather setup with explicit identities and optional short-lived nonce pairing with local confirmation
- [x] 6.2 Implement configuration validation, secure token-file support, configuration fingerprint checks, and sanitized errors
- [x] 6.3 Implement broker start, stop, status, test-notification, state purge, and credential-rotation commands
- [x] 6.4 Implement doctor checks for permissions, singleton state, loopback binding, Telegram connectivity, registration, catalogs, and OpenCode compatibility
- [x] 6.5 Add setup and doctor tests for healthy, incomplete, insecure, incompatible, conflicting, and offline installations
- [x] 6.6 Publish a minimal non-root Broker image with persistent-volume, runtime-secret, host-loopback port, and container smoke-test coverage

## 7. Documentation and Release

- [ ] 7.1 Document installation, BotFather setup, configuration, notification examples, reply behavior, diagnostics, update, and uninstall procedures
- [x] 7.2 Document the V1 single-computer limitation, Telegram privacy boundary, unsupported multi-computer polling, and future local/remote installation modes
- [x] 7.3 Maintain an English canonical reference and a matching Traditional Chinese overview
- [ ] 7.4 Add threat-model, protocol, data-retention, compatibility, and contributor documentation
- [ ] 7.5 Configure reproducible npm publishing, provenance, changelog generation, license checks, and release smoke tests
- [ ] 7.6 Index the implemented code with GitNexus and run graph-backed impact checks before the first public release
