## ADDED Requirements

### Requirement: Gateway sharing
The OMO extension SHALL connect to the Gateway configured by the `opencode-telegram-link` OpenCode plugin entry and MUST NOT start a Gateway or poll Telegram itself. Its connection SHALL be owned by the OMO process so that a session reload keeps existing route generations.

#### Scenario: Gateway is unreachable
- **WHEN** the configured Gateway cannot be reached
- **THEN** the extension MUST fail without spawning a Broker and SHALL record the failure in its trace log

#### Scenario: Session reloads
- **WHEN** an OMO session reloads its extensions
- **THEN** replies bound to notifications sent before the reload SHALL still reach that session

### Requirement: Settled notifications
The extension SHALL publish a completion or final-error notification only after OMO reports that the root session has settled, and MUST NOT notify user-aborted runs, execution children, or worker sessions.

#### Scenario: Root session settles normally
- **WHEN** an interactive root session settles after an assistant reply
- **THEN** one completion notification SHALL be published with the reply text as its summary

#### Scenario: User aborts the run
- **WHEN** the last assistant message stopped because the user aborted it
- **THEN** no notification SHALL be published

### Requirement: Waiting-for-answer notifications
The extension SHALL publish a pending-question notification for each `ask_user` question and for host dialogs that open while the agent is running, and MUST NOT notify dialogs the user opened while the session was idle.

#### Scenario: Agent asks a question with options
- **WHEN** OMO registers an `ask_user` question with options
- **THEN** the notification SHALL list the question and its options as reply buttons

### Requirement: Remote session interaction
The extension SHALL deliver Telegram session prompts as follow-up user messages to the exact open session, answer only non-blocking pending questions through the session's control endpoint, and interrupt a running turn for a cancel command. Commands for closed sessions, closed questions, or blocking questions MUST be refused without affecting another session.

#### Scenario: Reply to a completion notification
- **WHEN** an authorized reply is bound to an open OMO session
- **THEN** the text SHALL be queued as a follow-up message in that session

#### Scenario: Button answers a blocking question
- **WHEN** a question reply targets a blocking question
- **THEN** the extension MUST refuse it as requiring terminal intervention

#### Scenario: Cancel a running session
- **WHEN** a cancel command targets a session that is running a turn
- **THEN** the turn SHALL be interrupted and no completion notification SHALL be published for it

### Requirement: Route activity
The extension SHALL mark a session's route active when a root turn starts and inactive when it settles, without changing the route generation.

#### Scenario: Earlier question buttons after the session settles
- **WHEN** a non-blocking question was notified and the session later settles
- **THEN** the question's buttons SHALL still resolve to the session's route

### Requirement: Installation
Setup SHALL offer to install the extension when an OMO agent directory exists, copying the bundled extension so it does not depend on a package cache. Uninstall SHALL remove the extension only when its entry file matches what setup installed.

#### Scenario: Uninstall finds a developer-installed extension
- **WHEN** the extension directory's entry file differs from the setup-generated entry
- **THEN** uninstall MUST leave the directory in place and report it
