#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  if [ -d "/state" ]; then
    STATE_UID=$(stat -c '%u' /state 2>/dev/null || stat -f '%u' /state 2>/dev/null || echo "")
    STATE_GID=$(stat -c '%g' /state 2>/dev/null || stat -f '%g' /state 2>/dev/null || echo "")
    if [ "$STATE_UID" != "" ] && [ "$STATE_UID" != "0" ]; then
      usermod -o -u "$STATE_UID" opencode 2>/dev/null || true
      if [ "$STATE_GID" != "" ] && [ "$STATE_GID" != "0" ]; then
        groupmod -o -g "$STATE_GID" opencode 2>/dev/null || true
      fi
    fi
  fi
  chown -R opencode:opencode /app 2>/dev/null || true
  exec gosu opencode bun /app/dist/broker/main.js "$@"
fi

exec bun /app/dist/broker/main.js "$@"