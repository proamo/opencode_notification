# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    OPENCODE_TELEGRAM_CONTAINER=1 \
    OPENCODE_TELEGRAM_BROKER_STATE_DIR=/state \
    OPENCODE_TELEGRAM_BROKER_BIND_HOST=0.0.0.0 \
    OPENCODE_TELEGRAM_BROKER_PORT=42617

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 opencode \
    && useradd -u 10001 -g opencode -d /nonexistent -s /usr/sbin/nologin opencode \
    && mkdir -p /state \
    && chown -R opencode:opencode /app /state

COPY dist ./dist
COPY package.json README.md LICENSE ./
COPY container/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

VOLUME ["/state"]
EXPOSE 42617/tcp

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["start"]
