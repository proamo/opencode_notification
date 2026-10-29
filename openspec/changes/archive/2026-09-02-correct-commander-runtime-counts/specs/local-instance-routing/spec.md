## ADDED Requirements

### Requirement: Logical connection and activity accounting
One OpenCode process SHALL expose at most one registered notifier instance per canonical project directory, even when OpenCode invokes the configured plugin factory multiple times. Different processes or project directories SHALL retain distinct instance identities. Route availability and execution activity SHALL be tracked separately: inactive routes MUST remain available for exact authorized continuation but MUST NOT appear in Commander or `/sessions` active counts.

#### Scenario: Plugin factory is invoked repeatedly
- **WHEN** one OpenCode process initializes the notifier more than once for the same project directory
- **THEN** all invocations SHALL use the same instance identity, exactly one SHALL own the registered connection, and duplicate initialization SHALL fail closed without duplicating routes or notifications

#### Scenario: Separate OpenCode windows use the same project
- **WHEN** two OpenCode processes initialize the same project directory
- **THEN** each process SHALL receive a distinct instance identity and MAY own one connection

#### Scenario: Session becomes busy
- **WHEN** the plugin observes `session.status=busy` for a routable session
- **THEN** the route SHALL be marked active and SHALL appear once in active-session views

#### Scenario: Session becomes idle
- **WHEN** the plugin observes `session.idle` or a terminal session error
- **THEN** the route SHALL be marked inactive and removed from active-session views while exact authorized continuation routing remains available

#### Scenario: Legacy client omits activity metadata
- **WHEN** an authenticated pre-RC.9 client registers a route without an activity field
- **THEN** the Gateway SHALL treat the route as active for mixed-version compatibility
