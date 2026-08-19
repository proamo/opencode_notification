# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    OPENCODE_TELEGRAM_BROKER_STATE_DIR=/state \
    OPENCODE_TELEGRAM_BROKER_BIND_HOST=0.0.0.0 \
    OPENCODE_TELEGRAM_BROKER_PORT=42617

COPY dist ./dist
COPY package.json README.md LICENSE ./

RUN addgroup --system --gid 10001 opencode \
    && adduser --system --uid 10001 --ingroup opencode --home /nonexistent --shell /usr/sbin/nologin opencode \
    && mkdir -p /state \
    && chown -R opencode:opencode /app /state

USER 10001:10001
VOLUME ["/state"]
EXPOSE 42617/tcp

ENTRYPOINT ["bun", "/app/dist/broker/main.js"]
CMD ["start"]
