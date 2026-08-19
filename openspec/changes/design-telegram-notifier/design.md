## Context

See `proposal.md` for motivation and product scope. The implementation runs inside multiple independent OpenCode processes, while the Telegram Bot API permits only one effective `getUpdates` consumer per bot. OpenCode plugin event payloads and SDK methods are versioned independently from this package, and Telegram replies arrive without an OpenCode process or session context unless the notifier records that context when sending the original message.

The implementation therefore has two runtime roles:

- An OpenCode plugin instance observes one process, calls that process's SDK, and maintains live session state.
- One broker process per operating-system user and computer owns Telegram long polling, outbound delivery, durable message-to-route mappings, and connections to all local plugin instances.

Both roles run on Bun and are distributed in one npm package. There is no network service between Telegram and the local broker other than the user-owned Telegram bot's HTTPS connection.

The Broker may alternatively run as one Docker container on the same computer. OpenCode and its plugin remain outside that container. Docker mode changes packaging and the container-side bind address, not the one-computer trust model or routing protocol.

## Goals / Non-Goals

**Goals:**

- Route every accepted Telegram action to exactly the registered plugin instance, project, session, and pending interaction represented by the replied-to Telegram message.
- Make singleton broker startup safe when several OpenCode processes start concurrently.
- Keep secrets and session content out of local state and Telegram messages unless required for an enabled interaction.
- Degrade predictably across broker restarts, Telegram outages, plugin disconnects, and supported OpenCode API changes.
- Leave protocol and identity seams that do not prevent a later multi-computer design.

**Non-Goals:**

- V1 does not connect one bot to more than one computer. Running the same bot token on two computers is an unsupported configuration and produces a Telegram polling conflict.
- V1 does not queue user commands for disconnected OpenCode processes, provide remote permission approval, expose a non-loopback broker endpoint, or guarantee exactly-once effects across a process crash.
- The broker is not a conversation mirror, general Telegram command bot, hosted relay, or durable OpenCode job manager.
- Cross-operating-system-user routing on the same computer is not supported. Each OS user has an independent broker and state directory.

## Decisions

### 1. Plugin and singleton broker topology

Each OpenCode process loads one plugin instance. The plugin subscribes to supported session, error, question, and permission events, normalizes them into package-owned event types, and connects to the broker. It never contacts Telegram directly. The broker alone calls `getMe`, `deleteWebhook`, `getUpdates`, `sendMessage`, and related Telegram methods.

The plugin is the authority for live OpenCode state and SDK calls. The broker is the authority for Telegram update offsets, Telegram message mappings, authorization, and delivery policy. The broker cannot invoke OpenCode SDK APIs itself; it sends a typed command over the connection that registered the route and requires a typed result.

This split prevents competing long polls while avoiding a local HTTP control server in every OpenCode process. It also makes disconnection authoritative: when a plugin WebSocket closes, all of that instance's routes become offline immediately.

**Alternatives considered:** Direct Telegram polling in every plugin was rejected because Telegram delivers an update to only one poller and concurrent pollers cause conflicts. A broker that discovers OpenCode HTTP servers was rejected because it would require broader credentials and would couple routing to undocumented server discovery. A hosted relay was rejected by the privacy and deployment boundaries.

### 2. Bun runtime and package layout

The npm package exports the OpenCode plugin entry point and a `bin` entry named `opencode-telegram-broker`. Release artifacts contain bundled JavaScript targeting the minimum documented Bun version, embedded `en` and `zh-TW` catalogs, source maps, and TypeScript declarations for configuration. The broker uses `bun:sqlite`, Bun WebSocket support, `fetch`, and standard Web Crypto APIs. No postinstall script or background service is installed.

The plugin locates the broker entry from its own resolved package directory and starts it with the current Bun executable. It does not assume a globally installed CLI or invoke a package manager. Broker and plugin code may come from different package versions during rolling upgrades, so they still perform protocol negotiation.

Configuration is resolved by each plugin from plugin options plus documented environment or token-file references. Inline bot tokens are accepted for compatibility with OpenCode plugin options but discouraged. `tokenFile` and configuration files must be regular files owned by the current user and not accessible to group or other users. A newly started broker receives the resolved Telegram configuration only through the authenticated loopback channel and retains the token in memory, never in SQLite or logs. Later registrations must match the active configuration fingerprint, excluding non-semantic formatting; otherwise registration fails with a diagnostic rather than silently switching bots or authorization policy.

**Alternatives considered:** Shipping TypeScript source only was rejected because package resolution and runtime transpilation behavior are harder to reproduce. A native standalone binary was rejected because OpenCode already requires Bun and a native build matrix would add release complexity. A permanently installed OS service was rejected because lifecycle and setup would become platform-specific.

### 3. Identity and route keys

The following identities are used:

- `machineId`: a random UUID generated once and stored in broker state. It is not a hostname, MAC address, or other fingerprint.
- `instanceId`: a random UUID generated on each plugin load. It is never derived from a PID, because PIDs are reused.
- `projectId`: `base64url(HMAC-SHA-256(machineRouteSalt, canonicalProjectPath))`. The canonical path is resolved by the plugin, but only the opaque ID and an independently redacted display label leave the plugin.
- `sessionId`: the OpenCode session identifier.
- `routeGeneration`: a random UUID assigned when a plugin registers or re-registers a session route.

The canonical route key is `(machineId, instanceId, projectId, sessionId, routeGeneration)`. All five fields are present in broker envelopes and persisted message mappings. A route is usable only while the same authenticated WebSocket owns the matching `instanceId` and generation. Reconnection creates a new generation and invalidates actionability of old mappings, even if the OpenCode session ID is reused.

The machine route salt and machine ID are held in broker state with mode `0600`; they are not Telegram credentials. Display names are not keys and may collide. PIDs, ports, project basenames, and Telegram message text are never used to select a route.

**Routing invariants:**

- The broker sends a command only on the WebSocket that registered the complete route key.
- A Telegram action must resolve through the exact `(chatId, messageId)` of the message being replied to or the exact opaque callback token attached to that message.
- Authorization, route freshness, interaction kind, pending state, and TTL are checked before any user text is forwarded.
- Missing, ambiguous, stale, incompatible, or offline routes fail closed and receive localized feedback where doing so does not disclose information.
- Neither message text nor user-supplied route-like values can override a persisted route.

**Alternatives considered:** Filesystem paths as project IDs were rejected because they disclose local layout and are awkward Telegram keys. A key containing only `sessionId` was rejected because session identifiers are not guaranteed to be globally unique and cannot distinguish process restarts. Human-readable reply codes were rejected because they can be mistyped, forwarded, or replayed.

### 4. Loopback WebSocket protocol

The broker binds only to `127.0.0.1` on a configurable, deterministic port, defaulting to a package-assigned high port documented with the release. It does not bind `0.0.0.0`, a LAN address, or a Unix socket fallback in V1. The fixed TCP port is both the discovery endpoint and the final singleton primitive.

Every frame is UTF-8 JSON with this envelope:

```json
{
  "protocol": { "major": 1, "minor": 0 },
  "type": "register",
  "requestId": "uuid",
  "sentAt": "RFC3339 timestamp",
  "payload": {}
}
```

Frames have a 256 KiB hard limit, schema validation, known-type validation, and bounded string/array lengths. Unknown fields are ignored only when negotiated protocol rules permit them; unknown message types are rejected. Request/response pairs use `requestId`; commands additionally contain a broker-generated `commandId`. Notifications contain a plugin-generated `eventId` and route key. Heartbeats detect half-open connections.

Authentication uses a random 256-bit broker secret stored in the runtime/state directory with mode `0600`. The initial HTTP upgrade supplies the secret in an `Authorization: Bearer` header, not in the URL. The broker compares it in constant time and rejects unauthenticated upgrades before accepting protocol frames. The first frame then declares package version, OpenCode version, machine ID expectation, instance ID, and capabilities. The broker returns its versions and negotiated capabilities.

Loopback is not considered sufficient authentication: another process running as the user can connect to loopback, and another OS user may be able to attempt connections. File permissions protect the bearer secret from other users. Processes already compromised under the same OS account remain inside the local trust boundary and cannot be fully isolated by this design.

**Alternatives considered:** HTTP polling between plugin and broker was rejected because bidirectional commands and liveness are simpler over one WebSocket. Unix domain sockets were considered more restrictive but rejected for V1 due to Windows portability and path/permission differences. Putting the secret in a query parameter was rejected because URLs are commonly logged.

### 5. Broker discovery, election, and lifecycle

On startup, a plugin performs these steps:

1. Read or create the user-scoped broker secret and state directory using restrictive permissions.
2. Connect to the configured loopback port and perform an authenticated health/compatibility handshake.
3. If no broker answers, spawn the package's broker executable detached from the OpenCode process and retry with bounded exponential backoff.
4. Register only after a successful handshake.

Several plugins may spawn candidates concurrently. Each candidate attempts the exclusive port bind. Exactly one bind succeeds; candidates receiving `EADDRINUSE` connect to and validate the existing broker, then exit successfully. A port occupied by a process that does not pass the authenticated broker handshake is reported as a conflict. No candidate kills it, scans for another port, or deletes state. This makes the kernel's exclusive bind, rather than a stale PID or lock file, the election authority.

The broker writes an informational discovery record atomically after binding, containing port, PID, broker nonce, protocol version, and start time but no secret. It removes the record only if its nonce still matches. The record improves diagnostics but is never trusted over a live handshake.

The detached broker survives the OpenCode process that first spawned it. It exits gracefully after a configurable idle period when no plugin connections, pending Telegram interactions, or deliverable outbox entries remain. During shutdown it aborts long polling, checkpoints state, closes the listener, and removes its matching discovery record. `SIGTERM` and `SIGINT` follow the same path; an ungraceful exit is recovered from SQLite and exclusive binding on next startup.

**Alternatives considered:** PID files and stale lock reclamation were rejected as the election authority because PID reuse and suspended processes can create split brain. Random ports plus a discovery file were rejected because atomic publication and stale-file recovery are more complex. Keeping the broker alive forever was rejected because installation does not create an OS-managed service.

### 6. Telegram polling, authentication, and ownership

Only the elected broker starts long polling. Before polling, it calls `getMe` and verifies that the configured token's bot ID matches any persisted bot fingerprint. It calls `deleteWebhook` without dropping pending updates, then uses one sequential `getUpdates` loop with an allowed-update list limited to messages and callback queries used by the feature. The next update offset is advanced only after an update has reached a terminal local disposition: rejected, dispatched and acknowledged, or failed with explicit user feedback. The offset is then committed transactionally with idempotency state.

V1 authorizes exactly one numeric Telegram `userId` and one private `chatId`; both must match on every incoming update. Group, supergroup, channel, anonymous-admin, forwarded, and business-chat contexts are rejected. Normal setup requires explicit IDs. Guided pairing may populate them only after the local CLI displays a high-entropy, short-lived nonce and receives that nonce from a private chat whose user ID equals the message sender; the CLI displays the resulting IDs and requires local confirmation before persisting them. Pairing mode automatically expires and cannot coexist with normal command dispatch.

The broker sends only to the pinned chat. Unauthorized updates are discarded before parsing command text and are logged only as counters and update IDs. Callback query data is an opaque random token, not a serialized route. Telegram's TLS endpoint and bot-token authentication protect transport to Telegram; Telegram itself necessarily sees notification and reply content and is outside the local trust boundary.

If Telegram returns `409 Conflict`, the broker stops polling and reports that the bot is active elsewhere. It does not repeatedly take over the update stream. This behavior is also how accidental use of one token on two computers becomes visible rather than pretending to support multi-computer routing.

**Alternatives considered:** Username authorization was rejected because usernames are optional and mutable. Group-chat support was rejected because sender and visibility semantics broaden the trust boundary. Webhooks were rejected because they require an externally reachable endpoint. Automatically trusting the first incoming chat was rejected because bot usernames are public and first-contact races are unsafe.

### 7. State model and persistence

The broker stores state in an XDG-compliant per-user directory, preferring `XDG_STATE_HOME` and falling back to the platform's documented user state location. Directories use mode `0700`; the SQLite database, bearer secret, route salt, and any token file use mode `0600`. SQLite runs in WAL mode with foreign keys and a schema version.

The database contains these logical tables:

- `meta`: schema version, random machine ID, route salt reference, Telegram bot ID fingerprint, and last committed update offset.
- `message_routes`: Telegram chat/message ID, route key, message kind, interaction ID where applicable, creation/expiry times, route generation, and terminal status.
- `outbox`: redacted, fully formatted outbound payload, idempotency key, priority, attempt count, next attempt, expiry, and delivery result.
- `inbound_updates`: Telegram update ID, opaque action ID, disposition, timestamps, and hashes needed for deduplication. Raw user reply text is not retained.
- `notification_dedupe`: event idempotency key and expiry.

Live WebSockets, bot tokens, canonical project paths, raw OpenCode payloads, raw Telegram replies, and pending command text are never persisted. Route rows may remain briefly after disconnect for accurate "offline" feedback, but the live connection registry is the sole authority for dispatch. Expired and terminal rows are deleted by periodic bounded cleanup; `VACUUM` is an explicit maintenance operation rather than a hot-path action.

Database migrations are forward-only within a protocol major version and execute transactionally after making a timestamped database backup. A database from a newer unsupported schema causes startup to fail without modification. Corrupt state is moved aside only by an explicit repair command; the broker does not silently reset identity or mappings.

**Alternatives considered:** Flat JSON files were rejected because update offsets, mappings, and outbox changes require atomic multi-record commits. Persisting complete event payloads was rejected because it enlarges the local sensitive-data footprint. An in-memory-only broker was rejected because restarts would lose Telegram offsets and could reroute or duplicate replies without an auditable terminal state.

### 8. Session state, roots, and subagents

Each plugin keeps an in-memory state machine per session:

`unknown -> active -> waiting_question | waiting_permission | idle_completed | failed -> active/closed`

Transitions are derived from normalized OpenCode events and reconciled with an SDK lookup before a remote action. Pending questions and permissions are keyed by their OpenCode interaction IDs, not merely by session. A command is accepted only if its expected source state still matches current OpenCode state.

The plugin records parent/root relationships from session metadata. Lifecycle completion and routine error notifications are emitted only for root sessions by default. This avoids one user task producing notifications for every delegated subagent. Questions and permission requests that block progress are notified even when they originate in a subagent; their route points to the originating session and interaction, while the message identifies the root session context. A Telegram session prompt is allowed only for a root session in `idle_completed`; replying to a subagent lifecycle message can never create a prompt.

If parentage is unavailable, the plugin treats the session as non-root for promptability and as root only for explicitly configured notification behavior. This fail-closed asymmetry prevents text injection into a potentially unintended child session while still allowing diagnostics. Closing or deleting a root invalidates all descendant message mappings known to that plugin.

**Alternatives considered:** Forwarding every subagent event was rejected as noisy and ambiguous. Redirecting a subagent question to its root was rejected because the OpenCode question API expects the originating interaction. Treating unknown parentage as root for remote prompts was rejected because it weakens route safety.

### 9. Telegram message formatting and redaction

Messages are rendered from package-owned `en` and `zh-TW` catalogs. Locale selection is deterministic: explicit notifier locale, then a supported OpenCode locale if exposed, then a supported operating-system locale (`LC_ALL`, `LC_MESSAGES`, or `LANG` on Unix-like systems and the documented platform locale API elsewhere), then `en`. Locale identifiers are canonicalized before matching. No user content is sent to an external translation or detection service. A single broker rejects registrations whose bot-wide authorization settings conflict; per-route content locale may differ because it is included in each normalized notification.

Telegram `HTML` parse mode is used with a small allowlist generated by the renderer; all dynamic values are escaped before insertion. Each message has a stable header, event label, redacted project display name, optional session label, timestamp, status, and concise action instruction. Session outputs, source code, tool arguments/output, environment variables, filesystem paths, and model transcripts are omitted by default. Question notifications may include the redacted question text and answer options because they are necessary to answer; permission notifications include only permission category and a safe summary, never raw command arguments.

Redaction occurs in the plugin before data crosses the local socket and again in the broker before persistence or Telegram delivery. It combines field allowlists, built-in credential/token patterns, path and high-entropy value masking, and user-configured regular expressions. Configuration rejects invalid or unbounded regular expressions, and redaction operates under input-length limits. Logs use structured metadata and never include bot tokens, bearer secrets, canonical paths, reply text, or formatted message bodies. A diagnostic export applies the same policy.

Rendered messages are measured using Telegram's post-entity character rules. Optional fields are removed in priority order, then remaining dynamic text is truncated with an explicit marker before Telegram's limit. The renderer never splits an escape sequence or HTML entity. Formatting failures fall back to escaped plain text containing only the minimal event label and local-intervention instruction.

**Alternatives considered:** Markdown was rejected because escaping is more error-prone for arbitrary project/question text. Sending full session summaries was rejected because automatic summarization cannot reliably prevent secret disclosure. Redacting only in the broker was rejected because sensitive values would already have crossed process boundaries and could enter protocol diagnostics.

### 10. Telegram message IDs and action classification

After `sendMessage` succeeds, the broker stores `(chatId, messageId)` and its action metadata in the same transaction that marks the outbox item delivered. Telegram replies are actionable only when `reply_to_message.message_id` resolves to that row. Inline question buttons use one-time random callback tokens stored against the same row. Telegram message text is never parsed for a session identifier.

Each mapping has exactly one kind:

- `session_prompt`: accepts a non-empty text reply for an online root route currently in `idle_completed`. The broker sends `session.prompt`; the plugin revalidates state and calls the supported OpenCode session prompt API. It does not impersonate a question answer.
- `question_reply`: accepts only the response shape declared by the pending question. Buttons map to exact option IDs. Text is allowed only for free-text questions or an unambiguous documented option syntax. The broker sends `question.reply` with the interaction ID; the plugin verifies it is still pending and calls the question reply API.
- `permission_notice`: is never actionable in V1. It has no approval callbacks. Any reply receives a localized "use the terminal" response and no plugin command is sent.
- `informational`: cannot produce an action unless explicitly marked `session_prompt`; replies receive a non-actionable explanation.

Multi-question interactions are represented by one mapping plus a broker-side expected answer schema. The broker collects no partial answer state: V1 sends a single command only when one Telegram response can fully satisfy the schema; otherwise the notification requires terminal intervention. This avoids an ambiguous remote wizard and durable storage of partial answers.

Successful actions atomically mark the mapping consumed. Failed validation does not consume it unless the underlying interaction is stale. Edited Telegram messages are not commands, and replies to forwarded copies do not match the pinned chat/message key. Deleting a Telegram message does not reactivate or redirect its mapping.

**Alternatives considered:** Slash commands carrying route IDs were rejected as forgeable and error-prone. Treating every reply as a session prompt was rejected because it could answer the wrong API surface and bypass question validation. Permission buttons were rejected because remote permission approval is outside V1's trust and safety scope.

### 11. Idempotency, expiry, and TTLs

Plugin notifications carry an idempotency key based on `(route key, normalized event kind, stable OpenCode event or interaction ID)`. If OpenCode supplies no stable event ID, the plugin creates one when first observing the transition and keeps a bounded transition cache; the broker additionally uses a short-window hash of the normalized metadata as a defensive duplicate filter. The broker's unique outbox constraint prevents duplicate Telegram sends for one key.

Telegram `update_id` is the inbound idempotency key. Every resulting command receives a stable random `commandId`. A plugin keeps a bounded in-memory cache of command results and returns the previous result for a repeated command ID. The broker retries only while the same route generation remains connected and the action TTL remains valid. This gives effectively-once handling during ordinary reconnects, but not an absolute exactly-once guarantee if the plugin process crashes after OpenCode accepts a command and before acknowledgment.

Default TTL policy is:

- Pending question mappings expire at the earlier of the OpenCode interaction closing or 30 minutes.
- Session-prompt mappings expire after 24 hours or immediately when the route disconnects, generation changes, or session leaves `idle_completed`.
- Permission and informational mappings remain available for localized reply feedback for 24 hours but are never actionable.
- Outbound completion/error notifications expire after 24 hours; pending question and permission notifications expire with their interaction.
- Dedupe and terminal inbound records are retained for 7 days, then purged.

TTLs are configurable only within documented minimum and maximum bounds. Expiry is checked against a monotonic deadline while running and an absolute UTC timestamp after restart. Clock rollback cannot extend an in-memory action, and restart reconstruction caps remaining life at the configured maximum.

**Alternatives considered:** Permanent mappings were rejected because stale Telegram messages would remain attack and confusion surfaces. Mark-before-dispatch was rejected because it loses actions on transport failure; unbounded retry was rejected because it can duplicate prompts and resurrect stale intent.

### 12. Failure, reconnection, and offline behavior

Plugins reconnect with exponential backoff and full jitter, then re-register all currently eligible routes under new generations. During a short broker restart, a plugin holds a bounded in-memory notification buffer ordered by priority: questions and permissions, failures, then completions. Items retain original idempotency keys and TTLs. Buffer overflow drops the oldest lowest-priority item and emits a local warning. Nothing sensitive is written by the plugin to disk.

The broker persists a redacted outbound outbox. Telegram `429` responses honor `retry_after`; network and `5xx` failures use bounded exponential backoff with jitter; permanent `4xx` failures become terminal diagnostics. Long-poll network failures resume from the committed offset. A `401` disables Telegram activity until credentials change, and `409` disables polling until the competing consumer is removed. Delivery failures are reported locally to connected plugins when possible.

Inbound actions are never queued for an offline route. The broker sends a localized "OpenCode instance is offline; return to the terminal" message, records the terminal disposition, commits the Telegram update, and discards reply text. Backpressure is bounded per connection; an overproducing plugin is disconnected rather than allowed to exhaust broker memory. Malformed local frames, repeated authentication failures, and route ownership violations close the connection and produce security diagnostics without payload logging.

If SQLite is temporarily busy, the broker retries within a short bounded deadline and pauses Telegram offset advancement. If durable state cannot be written, it stops polling and outbound sends rather than process updates without mappings. Disk-full and corruption errors are surfaced through stderr, diagnostics, and connected plugins. The broker never recreates the database automatically after corruption.

**Alternatives considered:** Persisting inbound user commands until a plugin reconnects was rejected because user intent may be stale and the proposal excludes offline command queues. Dropping all outbound messages during a Telegram outage was rejected because short outages should not hide blocking questions. Infinite queues were rejected because they turn an outage into unbounded sensitive storage.

### 13. Version and OpenCode compatibility

The local protocol uses semantic `major.minor` negotiation. Different major versions do not connect. For the same major, peers advertise capabilities and use only their intersection; a required missing capability rejects registration, while an optional notification feature is disabled with a diagnostic. Patch versions do not alter wire behavior. The package version, broker build, Bun version, OpenCode version, protocol, and capabilities appear in redacted diagnostics.

OpenCode-specific event payloads are isolated behind a normalization adapter in the plugin. Supported OpenCode version ranges have fixture-based contract tests for event normalization and integration tests for SDK calls used by session prompts and question replies. At startup, the plugin checks the detected OpenCode version and required hooks/methods. Unsupported versions may run notification-only mode only when event normalization is known safe; remote interaction capabilities otherwise fail closed. Unknown event shapes are ignored with a rate-limited local diagnostic rather than guessed.

During package upgrade, an existing compatible broker may continue serving newer plugins. If incompatible, the plugin asks an idle broker to shut down through an authenticated control message; a broker with other clients is not replaced, and the plugin reports that all OpenCode processes must be restarted. There is no forced kill or protocol downgrade.

**Alternatives considered:** Requiring exact package versions was rejected because independently started OpenCode processes make atomic upgrades impractical. Duck-typing unknown OpenCode payloads was rejected because a mistaken interaction ID or state can misroute remote input. Silently starting another broker port was rejected because it would create competing Telegram pollers.

### 14. Multi-computer seam, explicitly unsupported in V1

Protocol envelopes and persisted message mappings include `machineId`, and Telegram transport is behind a broker-owned adapter. These choices allow a future design to introduce one update leader plus authenticated remote brokers without changing the local route key or plugin command model.

V1 nevertheless enforces `envelope.machineId == local machineId`, accepts only loopback plugin connections, and has no peer discovery, relay, remote authentication, or cross-machine queue. Documentation and diagnostics state that one bot token must be active on one computer. A Telegram `409` caused by another computer is an unsupported-configuration error, not failover. Adding multi-computer support requires a separate threat model, protocol, key management, leader election, and user-visible specification.

**Alternatives considered:** Using the Telegram chat as an implicit cross-machine fan-out was rejected because one poller consumes each update and cannot safely infer the target machine. Adding dormant LAN listening was rejected because an unaudited remote surface would weaken V1's trust boundary.

### 15. Optional single-container Broker mode

Native mode remains the default. The project also publishes a minimal, non-root image containing only the bundled Broker entry point and its Bun runtime. The image declares one state mount and one Broker port. Bot credentials and authorization configuration enter through runtime secrets or mounted permission-restricted files; they are never image layers or build arguments.

Inside the container the Broker binds its container interface so Docker can forward traffic. The documented invocation MUST publish it as `127.0.0.1:<host-port>:<container-port>`, never as an unqualified `-p <port>:<port>`. The authenticated protocol remains mandatory because sibling containers may reach the container interface. Setup and doctor inspect the effective host publication when available and treat all-interface publication as unsafe.

The plugin uses `brokerMode: "docker"` to disable detached native auto-spawn and connect to the configured host-loopback port. Container replacement with the same state volume preserves machine identity, Broker secret, SQLite state, and Telegram offset. Native and Docker Brokers MUST NOT run concurrently for the same state/token.

**Alternatives considered:** Bundling OpenCode into the image was rejected because users run independent host projects and terminals. Linux-only host networking was rejected as the primary instructions because it is not portable to all Docker Desktop environments. A container-exposed public API was rejected because Docker mode remains a local deployment, not the future remote Broker design.

## Risks / Trade-offs

- [Same-user compromise] Any malicious process running as the same OS user can potentially read the broker secret or plugin configuration and impersonate a plugin. -> Treat the OS account as the local trust boundary, enforce file permissions, minimize persisted data, and document that this is not a sandbox boundary.
- [Telegram disclosure] Telegram receives all sent notification content and user replies. -> Default to metadata-only messages, redact twice, require explicit enabling of question content, and document Telegram as an external data processor.
- [At-least-once edge] A crash after OpenCode accepts a command but before acknowledgment can cause an uncertain result. -> Use stable command IDs and plugin result caching, stop retries after route-generation loss, and tell the user to verify uncertain outcomes locally.
- [OpenCode API drift] Event or SDK changes may silently break state detection. -> Use version gates, normalization adapters, fixtures, compatibility CI, and fail closed for remote actions.
- [Fixed-port collision or local denial of service] Another process can occupy the configured port. -> Authenticate the endpoint, report a precise conflict, permit an explicit alternate configured port, and never fall back silently.
- [Broker as a single point of failure] A broker crash temporarily stops all local notifications. -> Keep plugins independent, reconnect automatically, buffer a small number of high-priority events, and recover durable offsets/outbox from SQLite.
- [Long Telegram outage] Persisted outbox content may remain on disk longer and blocking interactions may expire. -> Bound queue size and TTL, persist only redacted rendered content, prioritize blocking events, and surface local delivery status.
- [Redaction false negatives] Pattern-based redaction cannot prove that arbitrary text contains no secret. -> Use allowlisted fields and omit content by default; describe custom redaction as defense in depth, not a guarantee.
- [Redaction false positives or truncation] Useful question context may be removed. -> Preserve option identifiers, mark redactions/truncation visibly, and direct ambiguous interactions back to the terminal.
- [Multiple computers sharing a token] Telegram long polling conflicts and updates may be consumed by the wrong computer. -> Explicitly reject this topology, stop on `409`, and include bot ownership diagnostics and setup warnings.
- [SQLite contains limited message metadata] Local compromise or backups can reveal project activity timing. -> Use opaque project IDs, restrictive permissions, short retention, and a documented purge command.

## Migration Plan

1. Publish the package with plugin and broker entries, protocol major 1, SQLite schema 1, catalogs, setup/diagnostic commands, and a documented minimum Bun/OpenCode compatibility matrix.
2. On first configuration, validate the bot with `getMe`, pin the private user/chat through explicit IDs or confirmed nonce pairing, send a redacted test notification, and create user-scoped state with restrictive permissions.
3. Enable notification-only events first. Enable session prompts and question replies only after compatibility checks confirm the required OpenCode hooks and SDK methods. Permission handling remains notification-only regardless of configuration.
4. During ordinary upgrades, allow same-major capability negotiation and transactional database migration. Require restarting all local OpenCode processes when the protocol major changes or an active broker cannot be replaced safely.
5. To roll back within a protocol/database-compatible release, stop OpenCode processes, allow the broker to exit or terminate it gracefully, and install the prior package. For an incompatible database downgrade, restore the automatic pre-migration backup; never point older code at a newer schema.
6. To disable the feature, remove the plugin configuration and stop the broker gracefully. Local state remains for explicit user-directed purge so rollback does not silently destroy routing diagnostics or identity. Revoking the bot token through BotFather is the credential-containment rollback if exposure is suspected.
