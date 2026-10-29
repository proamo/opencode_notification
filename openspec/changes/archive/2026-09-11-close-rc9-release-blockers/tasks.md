## 1. Routing Isolation

- [x] 1.1 Add machine identity and canonical path to stable plugin identity
- [x] 1.2 Restrict stale-generation fallback to active full-composite routes
- [x] 1.3 Preserve inactive terminal state when metadata arrives out of order

## 2. Lifecycle Security

- [x] 2.1 Resolve missing lifecycle endpoint fields from private persisted state
- [x] 2.2 Reject public plaintext administrator lifecycle targets
- [x] 2.3 Make doctor role-aware without distributing administrator credentials to Nodes
- [x] 2.4 Limit uninstall operations to resources owned by the deployment mode

## 3. Verification

- [x] 3.1 Correct Telegram active and idle rendering
- [x] 3.2 Add focused regression tests and update main specifications
- [x] 3.3 Run full release gates, live endpoint checks, and independent final review
- [x] 3.4 Prevent stale clients from starting a Broker outside persisted deployment ownership and re-run live reply verification
