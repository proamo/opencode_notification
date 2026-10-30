## ADDED Requirements

### Requirement: Dashboard password login
The Gateway SHALL let the operator set a dashboard password (at least 8 characters) with `set-dashboard-password`, stored only as an argon2id hash in a current-user-only state file. When a password is set, `POST /v1/api/dashboard/login` SHALL accept only the password, MUST reject the Broker Secret as a login credential, and MUST reject legacy cookies that carry the Broker Secret. Login SHALL issue a signed, expiring HttpOnly session cookie that never contains the Broker Secret and is bound to the current password hash. Repeated failed logins from one address SHALL be temporarily blocked. `Authorization: Bearer` access with the Broker Secret SHALL remain available for API clients, and the Broker Secret SHALL remain the login key until a password is set.

#### Scenario: Password is set
- **WHEN** a password is set and the user submits the Broker Secret to the login endpoint
- **THEN** the login MUST be rejected

#### Scenario: Password changes
- **WHEN** the operator sets a new dashboard password
- **THEN** session cookies issued under the previous password MUST stop authorizing dashboard API calls
