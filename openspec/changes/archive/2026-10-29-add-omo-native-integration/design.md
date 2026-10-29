## Context

OMO extensions receive lifecycle events (`agent_start`, `agent_settled`, `ui_prompt_start`, `ask-user:asked/closed`, `session_start/shutdown`) and can send user messages. OMO reclaims sockets and timers opened from session callbacks on reload, and each interactive TUI session exposes a private control socket (`<agentDir>/rpc/tui/*.sock`, raw secret handshake, JSON lines).

## Decisions

- **Process-owned Gateway connection.** The extension connects from module scope and keeps state on `globalThis`, so `/reload` keeps route generations and replies to earlier notifications still route. Command handling is looked up through the process state so a reloaded build handles commands on an existing connection.
- **Settled notifications.** Notify on `agent_settled`, not `agent_end`; skip aborted runs, `spawnedBy` children, and worker sessions.
- **Session prompts.** Deliver with `sendUserMessage(text, { deliverAs: "followUp" })` to the session registered in `session_start`; reject when the session is not open.
- **Question answers and cancel.** Find the session's control socket via `list_sessions`, then send `extension_ui_response` (`uiRequestId`, answers keyed by question id) or `interrupt`. Blocking questions are refused as terminal intervention because the TUI control endpoint only answers non-blocking questions.
- **Route reuse.** Register a session route once; `agent_start` marks it active and settling marks it inactive by re-registering the same generation, because a new generation replaces the old one and invalidates earlier message bindings.
- **Stale host recovery.** Follow `deployment.json` only for a loopback configured host, same port, and an authenticated health probe; never spawn a Broker in that path.

## Failure handling

Gateway or control-socket failures are written to `/tmp/opencode_telegram_omo.log` and returned as rejected or stale command results; they never affect another session.
