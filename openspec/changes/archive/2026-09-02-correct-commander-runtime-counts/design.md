## Context

OpenCode 1.18 can invoke the same configured plugin factory multiple times in one long-running server process. The existing random per-constructor instance UUID turns those invocations into independent Gateway identities. Separately, the registry currently equates every routable route with active execution, although idle routes intentionally remain live for Telegram continuation.

## Goals / Non-Goals

**Goals:**

- Collapse duplicate plugin initialization within one process and project without merging separate OpenCode processes.
- Preserve exact idle-session continuation while reporting only busy sessions as active.
- Route lifecycle controls to the same explicit endpoint the Gateway uses.

**Non-Goals:**

- Persist process identities across OpenCode restarts.
- Remove idle routes, change route authorization, or infer activity from Dashboard refreshes.
- Merge separate VS Code/OpenCode windows that open the same directory.

## Decisions

### Derive instance identity from process and project

The client derives an RFC 4122-form UUID from SHA-256 of the process ID and normalized project directory. Repeated module copies and factory calls in the same process converge even if they do not share module globals. Separate processes remain distinct. The existing instance ownership map admits the first registration and rejects duplicates.

Alternative considered: deduplicate only in Commander. That would leave duplicate event handling, notifications, and ambiguous routes active.

### Add optional route activity metadata

Route registration carries an optional boolean. RC.9 clients emit inactive on initial metadata, active after busy, and inactive after idle/error. The registry retains inactive routes for exact lookup but excludes them from active lists and active project labels. Missing metadata defaults active for RC.8 compatibility.

Alternative considered: unregister idle routes. This would break remote continuation and require reconstructing precise route ownership before the next prompt.

### Centralize lifecycle HTTP destination formatting

Server probes and control clients share one host normalizer and URL formatter. CLI and doctor use explicit command/config values. Uninstall reads host and port from private persisted Gateway configuration, falls back to the RC.8 loopback default only when the file is absent, and rejects malformed present state.

## Risks / Trade-offs

- [PID reuse after a prior process exits] → The old socket is removed on close and ownership is process-lifetime only; project path is also part of the identity.
- [A duplicate factory loses registration] → This is intentional fail-closed ownership; the first initialized factory remains the sole event bridge.
- [Mixed-version routes lack activity] → Default them active until the client upgrades rather than hiding potentially running sessions.
- [Private state corruption blocks uninstall] → Preserve state and provide an actionable error instead of probing an unintended endpoint with administrator credentials.

## Migration Plan

1. Upgrade and restart the Gateway so it accepts activity metadata and configured lifecycle probes.
2. Restart each OpenCode window so duplicate factories derive the stable process-project identity.
3. Verify Commander connections match OpenCode processes and active sessions match busy status transitions.
4. Roll back by restoring the prior bundle and plugin; optional metadata remains protocol-compatible.
