## Decisions

- Session cookie `opencode_session=v1.<expiresAt>.<hmac>`, HMAC keyed by Broker Secret and password hash, so restarts keep sessions and a password change revokes them.
- The Gateway reads the hash file per request, so `set-dashboard-password` takes effect without a restart.
- 5 failures per address in 5 minutes return 429 until the window passes.
