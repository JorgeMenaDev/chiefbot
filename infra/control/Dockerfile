# The control plane image, for docker compose (compose.yaml) and the GCP control
# VM (infra/gcp). Build from the repo root: `docker build -f infra/control/Dockerfile .`.
# The first stage bundles apps/control into one file with `bun build`.
# SQLite and the projects' context live under /data: mount a volume or disk there.
# The connections people may turn on are read from /opt/chiefbot/connections at start.
FROM oven/bun:1-slim AS bundle
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts --production --filter @chiefbot/control && bun build apps/control/src/index.ts --target=bun --outfile /out/control.js

FROM oven/bun:1-slim
COPY --from=bundle /out/control.js /opt/chiefbot/control.js
COPY connections /opt/chiefbot/connections
ENV CHIEFBOT_DB_PATH=/data/control.sqlite CHIEFBOT_CONNECTIONS_DIR=/opt/chiefbot/connections
CMD ["bun", "/opt/chiefbot/control.js"]
