#!/bin/sh
set -e

if [ -d "/state" ] && [ "$(id -u)" = "0" ]; then
  chown -R opencode:opencode /state /app 2>/dev/null || true
  exec gosu opencode bun /app/dist/broker/main.js "$@"
fi

exec bun /app/dist/broker/main.js "$@"