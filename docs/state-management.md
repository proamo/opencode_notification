# Local State Management

The Broker stores routing and delivery state in `state.sqlite` under its current-user state directory. Native and Docker deployments use the same schema; Docker users persist the complete state directory as one volume.

The database contains opaque route identifiers, Telegram message identifiers, redacted outbound payloads, terminal update dispositions, update offsets, and idempotency keys. It does not store bot tokens, Broker authentication secrets, raw Telegram replies, complete prompts, source code, or tool output.

## Retention

The Broker periodically:

- marks expired actionable message routes as expired;
- marks expired pending outbox records as failed;
- removes terminal route and outbox records after their retention period;
- removes old inbound update and expired deduplication records;
- enforces hard row-count limits by deleting the oldest records.

Inspection returns only schema version, machine identity, update offset, and counts grouped by status. It never returns message bodies or outbound payloads.

## Purge

An explicit operational purge removes message routes, outbox records, inbound updates, deduplication records, and the Telegram update offset. It preserves the database schema and machine identity. Purge is never automatic during uninstall or startup.

## Corruption Repair

The Broker does not silently recreate a corrupt database. Repair requires all Broker processes to be stopped and explicit confirmation. A healthy database is refused unless the caller also uses an intentional force-reset option.

Repair moves the original database and any WAL/SHM sidecars to timestamped `pre-repair` archive paths before creating a replacement. If replacement creation fails, the archived database is restored. Archive deletion is always a separate user decision.
