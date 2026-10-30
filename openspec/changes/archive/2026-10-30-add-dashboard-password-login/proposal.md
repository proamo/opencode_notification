## Why

The dashboard login used the Broker Secret and stored it in the session cookie. The user wants a password login instead.

## What Changes

- Add `set-dashboard-password` (argon2id hash, private state file).
- Accept only the password at login once set; keep Bearer API access and the Broker Secret login until a password exists.
- Replace the secret-bearing cookie with a signed, expiring session bound to the password hash.
- Rate-limit failed logins per address.

## Non-goals

Multiple users, password recovery through Telegram, and hidden terminal input.
