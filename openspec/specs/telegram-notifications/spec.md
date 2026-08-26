# telegram-notifications Specification

## Purpose
Defines which OpenCode events produce Telegram notifications and the privacy, localization, noise-control, and delivery guarantees visible to users.
## Requirements
### Requirement: Supported notification events
The notifier SHALL support notifications for root-session completion, root-session errors, pending user questions, and pending permission requests. It MUST NOT send conversation turns, tool output, source code, or other session events merely because they are observable.

#### Scenario: Supported event is enabled
- **WHEN** an enabled completion, error, question, or permission event occurs for a root session
- **THEN** the notifier SHALL submit a notification representing that event

#### Scenario: Unsupported event occurs
- **WHEN** an event outside the supported notification event set occurs
- **THEN** the notifier MUST NOT submit a Telegram notification for that event

### Requirement: Configurable event filtering
The notifier SHALL allow each supported event category to be enabled or disabled, and MUST apply the configured filter before any Telegram delivery attempt.

#### Scenario: Event category is disabled
- **WHEN** an event occurs in a disabled category
- **THEN** the notifier MUST NOT send or retry a notification for that event

#### Scenario: Other categories remain enabled
- **WHEN** one event category is disabled and an event occurs in a different enabled category
- **THEN** the notifier SHALL continue to notify for the enabled category

### Requirement: Root-session filtering
The notifier SHALL send lifecycle notifications only for root sessions by default and MUST suppress equivalent child-session and subagent lifecycle events unless an explicit supported configuration enables them.

#### Scenario: Child session completes under the default policy
- **WHEN** a child session or subagent completes
- **THEN** the notifier MUST NOT send a completion notification

#### Scenario: Root session completes under the default policy
- **WHEN** a root session completes and completion notifications are enabled
- **THEN** the notifier SHALL send one completion notification

#### Scenario: Child session blocks on user input
- **WHEN** a child session or subagent has a question or permission request that requires user intervention
- **THEN** the notifier SHALL identify the root-session context and notify for the originating interaction without making the child session eligible for a session prompt

### Requirement: Deterministic localization
Every user-visible notifier message SHALL be rendered from an English or Traditional Chinese catalog. The notifier SHALL select locale in this order: an explicit supported notifier locale, a supported OpenCode locale when available, a supported operating-system locale, then English. It MUST NOT infer locale by sending user content to an external translation or language-detection service and MUST NOT mix catalog locales within one message except for user-provided text.

#### Scenario: Traditional Chinese is configured
- **WHEN** the configured locale is Traditional Chinese
- **THEN** all notifier-generated text in the notification SHALL use the Traditional Chinese catalog

#### Scenario: Locale is selected automatically
- **WHEN** no explicit locale is configured and OpenCode or the operating system exposes a supported Traditional Chinese locale
- **THEN** all notifier-generated text in the notification SHALL use the Traditional Chinese catalog

#### Scenario: No supported locale is available
- **WHEN** no explicit, OpenCode, or operating-system locale resolves to a supported catalog
- **THEN** all notifier-generated text in the notification SHALL use the English catalog

### Requirement: Minimal notification content and execution summary
Notifications SHALL identify the event type, formatted timestamp in host local time, and provide only the minimum routing context needed by the user (safe project label and session label). Completion notifications SHALL optionally include an AI-generated concise execution summary of completed actions while omitting raw transcripts, tool output, local paths, and secrets.

#### Scenario: Session completes with summary
- **WHEN** a session completes and AI summary fetching succeeds
- **THEN** the completion notification SHALL display a localized summary block (e.g. `📝 執行結論：` / `📝 Summary:`) truncated to safety limits

#### Scenario: Session completes without summary or error
- **WHEN** a session completes and summary fetching is unavailable or fails
- **THEN** the completion notification SHALL omit the summary block cleanly without failing delivery

#### Scenario: User action is required with interactive buttons
- **WHEN** a question or permission request requires user intervention
- **THEN** the notification SHALL attach Telegram inline keyboard buttons (`[ ✅ 允許本次 ]`, `[ ⚡ 總是允許 ]`, `[ ❌ 拒絕 ]` for permissions, or option buttons for questions) bound to secure callback tokens

### Requirement: Redaction before delivery
The notifier SHALL apply configured redaction rules and built-in secret redaction to every user-derived field before sending it to Telegram. Redaction MUST occur before persistence in delivery diagnostics, and an unredactable or invalid payload MUST fail closed rather than be sent unredacted.

#### Scenario: Message field contains a recognized secret
- **WHEN** a notification field contains a token, credential, or value matched by a configured redaction rule
- **THEN** the delivered notification and delivery diagnostics MUST replace that value with a non-reversible redaction marker

#### Scenario: Redaction cannot safely process a payload
- **WHEN** the notifier cannot establish that a user-derived payload was successfully redacted
- **THEN** it MUST suppress delivery and report a local sanitized error

### Requirement: Duplicate suppression
The notifier SHALL derive a stable deduplication identity from the source event identity, event category, and exact session route. It MUST deliver at most one notification for repeated observations of the same source event within the configured deduplication retention period.

#### Scenario: Same event is observed twice
- **WHEN** the identical source event for the same route is observed more than once within the retention period
- **THEN** the notifier SHALL send no more than one Telegram notification

#### Scenario: Similar events belong to different sessions
- **WHEN** otherwise similar events have different session routes
- **THEN** the notifier MUST treat them as distinct events

### Requirement: Lifecycle debounce
The notifier SHALL debounce transient lifecycle state changes for the same exact session route using a documented configurable interval. If the session becomes active again before a pending completion notification is emitted, the pending completion MUST be cancelled; question, permission, and error notifications MUST NOT be discarded by completion debounce.

#### Scenario: Session briefly appears complete and resumes
- **WHEN** a root session enters a completion state and resumes before the debounce interval expires
- **THEN** the notifier MUST NOT send the transient completion notification

#### Scenario: Session remains complete
- **WHEN** a root session remains complete through the debounce interval
- **THEN** the notifier SHALL send one completion notification

#### Scenario: Action-required event occurs during debounce
- **WHEN** a question, permission request, or error event occurs while completion is being debounced
- **THEN** the notifier SHALL process that event independently without waiting for the completion interval

### Requirement: Telegram delivery feedback
The notifier SHALL distinguish accepted Telegram delivery, retryable delivery failure, and permanent delivery failure in sanitized local status output. Retries MUST be bounded, MUST preserve the same deduplication identity, and MUST NOT result in multiple actionable records for one source event.

#### Scenario: Telegram accepts the message
- **WHEN** Telegram confirms that a notification was sent
- **THEN** the notifier SHALL record sanitized success status and the Telegram message identity needed for subsequent authorized interaction

#### Scenario: Telegram is temporarily unavailable
- **WHEN** Telegram returns a retryable failure
- **THEN** the notifier SHALL perform only the configured bounded retries and SHALL expose the final sanitized delivery status locally

#### Scenario: Telegram rejects the message permanently
- **WHEN** Telegram returns a non-retryable failure
- **THEN** the notifier MUST stop retrying that notification and SHALL expose a sanitized local failure without credentials or unredacted content

