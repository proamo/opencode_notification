# telegram-session-interaction Specification

## Purpose
Defines authorized, message-bound Telegram interactions that continue an available session or answer a pending question without enabling remote permission approval.
## Requirements
### Requirement: Allowed Telegram identity
The broker SHALL accept commands only when both the Telegram user identity and chat identity exactly match the configured allowed identities. Missing, malformed, forwarded, or mismatched identity data MUST fail closed, and unauthorized requests MUST NOT disclose route, project, session, or question state.

#### Scenario: User and chat are authorized
- **WHEN** an update has the exact configured Telegram user identity and chat identity
- **THEN** the update SHALL proceed to message binding and route validation

#### Scenario: User or chat is unauthorized
- **WHEN** either the Telegram user identity or chat identity does not exactly match configuration
- **THEN** the broker MUST reject the update without forwarding it or disclosing target state

### Requirement: Reply-to-message binding
An interactive Telegram response SHALL be valid only when it is a direct reply to a notifier-generated actionable bot message. The broker MUST resolve routing and action type from its stored binding to the replied-to bot message and MUST NOT accept route identifiers supplied only in user text, copied message text, forwarded messages, or replies to non-actionable notifications.

#### Scenario: User directly replies to an actionable notification
- **WHEN** an authorized user replies to a currently actionable notifier message
- **THEN** the broker SHALL validate the stored message binding before considering the response

#### Scenario: User sends an unthreaded command
- **WHEN** an authorized user sends text that is not a reply to an actionable notifier message
- **THEN** the broker MUST reject it and SHALL provide localized guidance to reply to the relevant bot message

#### Scenario: User replies to a copied or forwarded notification
- **WHEN** the update refers to copied content or a forwarded message rather than the original bot message binding
- **THEN** the broker MUST reject it without inferring a route from message text

### Requirement: Distinct interaction types
The system SHALL keep session prompts, question replies, and permission replies as distinct action types with separate validation. It MUST NOT reinterpret one action type as another, even when their text is identical.

#### Scenario: Reply targets a completed-session notification
- **WHEN** an authorized valid reply is bound to an eligible completed-session notification
- **THEN** the response SHALL be processed only as a new session prompt

#### Scenario: Reply targets a question notification
- **WHEN** an authorized valid reply is bound to a pending-question notification
- **THEN** the response SHALL be processed only as an answer to that exact question

#### Scenario: Reply targets a permission notification
- **WHEN** any Telegram reply is bound to a permission notification
- **THEN** the system MUST NOT interpret it as permission approval, denial, a question answer, or a session prompt

### Requirement: Continue an available session
The system SHALL allow an authorized reply to an eligible completed-session notification to submit the reply text as a new user prompt to the exact bound session when that route remains live and the session can accept a prompt. It MUST NOT create a different session or select a replacement route when the bound session is unavailable.

#### Scenario: Bound completed session is available
- **WHEN** a valid unexpired prompt reply targets a live session that can accept a prompt
- **THEN** the exact reply text SHALL be submitted once as a new user prompt to that session

#### Scenario: Bound session cannot accept a prompt
- **WHEN** a prompt reply targets an offline, missing, busy, or otherwise ineligible session
- **THEN** the system MUST reject the prompt without rerouting or queuing it and SHALL return localized failure feedback

### Requirement: Answer the exact pending question
The system SHALL accept an authorized response only for the exact pending question represented by the replied-to notification. The response MUST conform to that question's current answer constraints, and the system MUST NOT apply it to another pending question or convert an invalid answer into a session prompt.

#### Scenario: Valid answer targets the pending question
- **WHEN** a valid unexpired reply satisfies the constraints of the exact question that is still pending
- **THEN** the system SHALL submit the answer once to that question

#### Scenario: Answer violates question constraints
- **WHEN** a reply does not satisfy the pending question's allowed choices, cardinality, or input constraints
- **THEN** the system MUST reject it without resolving the question and SHALL return localized corrective feedback

#### Scenario: Different question is now pending
- **WHEN** the question bound to the message is no longer pending but another question exists in the session
- **THEN** the system MUST reject the reply and MUST NOT apply it to the other question

### Requirement: Permission requests remain terminal-only
V1 SHALL notify users of permission requests but MUST NOT approve, deny, or otherwise resolve OpenCode permissions from Telegram. Permission notifications and replies SHALL state that terminal intervention is required.

#### Scenario: User replies with approval language
- **WHEN** an authorized user replies "approve" or equivalent text to a permission notification
- **THEN** the permission MUST remain unresolved and the system SHALL direct the user to the terminal

#### Scenario: User replies with denial language
- **WHEN** an authorized user replies "deny" or equivalent text to a permission notification
- **THEN** the permission MUST remain unresolved and the system SHALL direct the user to the terminal

### Requirement: Interaction expiry
Every actionable message binding SHALL have a documented bounded expiry. A binding MUST also become unusable when its question is resolved, its route goes offline or is superseded, or its action is otherwise no longer valid; expiration MUST NOT cancel or mutate the underlying OpenCode session or pending terminal action.

#### Scenario: Reply arrives before expiry
- **WHEN** a reply arrives before expiry and all other action preconditions remain valid
- **THEN** the system SHALL continue normal authorization, route, and action validation

#### Scenario: Reply arrives after expiry
- **WHEN** a reply arrives after its binding expires
- **THEN** the system MUST reject it without forwarding and SHALL provide localized expiry feedback

#### Scenario: Question resolves before binding expiry
- **WHEN** the bound question is resolved locally before a Telegram reply arrives
- **THEN** the binding SHALL no longer accept an answer

### Requirement: Idempotent interaction processing
The broker SHALL process a Telegram update and its bound action at most once. Replayed updates, repeated delivery by Telegram, concurrent handling, and repeated replies to a single-use question binding MUST NOT cause duplicate prompts or duplicate question answers.

#### Scenario: Telegram delivers the same update twice
- **WHEN** the broker receives the same Telegram update identity more than once
- **THEN** no more than one OpenCode action SHALL occur

#### Scenario: Two answers race for one pending question
- **WHEN** two valid replies to the same single-use question binding are processed concurrently
- **THEN** at most one answer SHALL be submitted and the other SHALL receive stale-or-already-handled feedback

### Requirement: Interaction outcome feedback
For every authorized interaction attempt, the system SHALL provide localized Telegram feedback indicating accepted, rejected, expired, unavailable, invalid, or already handled status. Feedback MUST NOT claim success until the exact target instance has accepted the action.

#### Scenario: Target accepts the action
- **WHEN** the exact OpenCode target confirms acceptance of a prompt or question answer
- **THEN** the bot SHALL report localized success

#### Scenario: Forwarding fails or acknowledgement times out
- **WHEN** the target does not confirm acceptance within the bounded acknowledgement interval
- **THEN** the bot MUST NOT report success and SHALL report localized failure or indeterminate status without automatically resubmitting the action

### Requirement: Remote text safety boundary
Telegram response text SHALL be treated as untrusted user input and submitted only through the OpenCode operation appropriate to the bound action. It MUST NOT be interpreted by the broker as a shell command, configuration instruction, route selector, permission decision, or local file operation.

#### Scenario: Reply resembles a command or route override
- **WHEN** authorized reply text contains shell syntax, route identifiers, or configuration-like content
- **THEN** the broker SHALL treat it solely as prompt text or a constrained question answer according to the stored action type

