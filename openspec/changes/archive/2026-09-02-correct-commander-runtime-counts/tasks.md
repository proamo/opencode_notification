## 1. Connection and Session Accounting

- [x] 1.1 Derive a stable process-project plugin instance UUID
- [x] 1.2 Reject duplicate factory clients through existing instance ownership
- [x] 1.3 Add optional route activity metadata with legacy-active fallback
- [x] 1.4 Update busy, idle, and error event handling without deleting routable idle routes
- [x] 1.5 Filter Commander project activity and active-session lists by route activity

## 2. Lifecycle Endpoint Control

- [x] 2.1 Route start reuse, status, stop, and purge probes through configured host and port
- [x] 2.2 Route doctor checks through configured host and port
- [x] 2.3 Read and validate the persisted endpoint during fail-closed uninstall
- [x] 2.4 Normalize wildcard and IPv6 control URLs

## 3. Verification and Documentation

- [x] 3.1 Add duplicate instance, active-to-idle, inactive exact routing, and explicit endpoint tests
- [x] 3.2 Update specification links, WebSocket topology wording, and uninstall retention documentation
- [x] 3.3 Run full release checks and validate the upgraded live Gateway with five OpenCode windows
