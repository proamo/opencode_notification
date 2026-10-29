## ADDED Requirements

### Requirement: In-place route activity updates
A client SHALL be able to change an owned route's active state by re-registering the same route generation. The Gateway SHALL update the activity flag without replacing the generation, so message bindings created for earlier notifications of that session remain routable.

#### Scenario: Session goes idle after a question notification
- **WHEN** a client marks a session route inactive after a question notification was sent for it
- **THEN** the question's message binding SHALL still resolve to the same route generation
