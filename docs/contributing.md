# Contributor Guide

This project uses Bun, TypeScript, Biome, OpenSpec, and GitNexus. The implementation favors small, auditable changes with tests and explicit security boundaries.

## Setup

```sh
bun install
bun run build
```

Useful commands:

```sh
bun run check
bun test
bun run build
npx --yes openspec validate design-telegram-notifier --strict
```

## Development Rules

Follow these rules for code changes:

- Keep production changes minimal and directly tied to an OpenSpec task or bug.
- Prefer typed schemas at trust boundaries.
- Do not log bot tokens, broker secrets, reply text, raw Telegram payloads, source code, or canonical paths.
- Do not add Telegram credentials or real chat IDs to tests.
- Use recorded or fake Telegram fixtures for tests.
- Fail closed when routing, authorization, protocol, or compatibility is ambiguous.
- Keep native broker listening on loopback. Container mode may bind to `0.0.0.0` only inside the container with host port publishing restricted to `127.0.0.1`.
- Do not implement remote permission approval in V1.

## GitNexus Checks

Before editing a production function, class, or method, run impact analysis for the symbol and understand the blast radius. Warn before proceeding when the risk is high or critical.

Before committing, run:

```sh
node .gitnexus/run.cjs detect_changes --repo opencode_notification
node .gitnexus/run.cjs check --cycles --repo opencode_notification
```

For staged review, use:

```sh
node .gitnexus/run.cjs detect_changes --scope staged --repo opencode_notification
```

If the index reports FTS inconsistency, repair and rebuild the PDG index:

```sh
node .gitnexus/run.cjs analyze --repair-fts
node .gitnexus/run.cjs analyze --pdg
```

## Test Strategy

Expected coverage areas:

- Configuration validation and token-file permission rejection.
- Broker singleton election, authenticated discovery, health/status/stop controls, and port conflict behavior.
- Protocol schema validation, frame limits, heartbeat timeout, route ownership, and command results.
- Telegram authorization, polling offsets, conflict handling, retry handling, and outbox persistence.
- Notification formatting, redaction, HTML escaping, truncation, and locale catalog parity.
- Reply behavior for accepted, rejected, expired, offline, invalid, stale, terminal-only, and indeterminate outcomes.
- Multi-project and multi-process routing isolation.
- Setup, doctor, Docker image contracts, and operational command output.

Run the full verification set before each task commit:

```sh
npx --yes bun run check
npx --yes bun test
npx --yes bun run build
npx --yes openspec validate design-telegram-notifier --strict
node .gitnexus/run.cjs detect_changes --repo opencode_notification
node .gitnexus/run.cjs check --cycles --repo opencode_notification
```

## Release Expectations

Release work must keep npm artifacts reproducible and minimal. Package outputs should include built JavaScript, source maps, type declarations, `README.md`, and `LICENSE`; they should not include source tests, local state, `.gitnexus`, credentials, or generated secrets.

Before publishing, verify package contents with a dry-run pack, run release smoke tests from the packed artifact, and validate provenance settings.
