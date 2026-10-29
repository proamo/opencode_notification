## Why

The user runs OMO Native alongside OpenCode and wants the same Telegram notifications and remote replies for OMO sessions. Investigation also found that plugin configurations could keep a stale loopback Gateway host after the Gateway moved to a private overlay IP, silently disabling notifications.

## What Changes

- Add an OMO Native extension that shares the existing Gateway and Telegram bot: settled completion and final-error notifications, waiting-for-answer notifications, Telegram replies as follow-up messages, option answers for non-blocking questions, and cancel through the session control endpoint.
- Keep one route generation per OMO session and toggle its activity in place.
- Install the extension from setup when OMO is detected and remove it on uninstall only when setup installed it.
- Recover from a stale loopback plugin host by following the native deployment record.
- Isolate HOME, XDG, and OMO agent directories in tests.

## Non-goals

- Starting new OMO sessions from Telegram.
- Answering blocking (full-screen) OMO questions remotely; OMO 5.1.51 accepts remote answers only for non-blocking questions.
- Notifying OMO child tasks or worker sessions.

## Privacy boundaries

The extension uses the existing Node credential model, sends the same notification fields as OpenCode, and never starts a Gateway or polls Telegram.
