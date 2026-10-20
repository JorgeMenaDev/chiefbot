# The control plane image, for docker compose (compose.yaml) and the GCP control
# VM (infra/gcp). Build from the repo root: `docker build -f infra/control/Dockerfile .`.
# The first stage bundles apps/control into one file with `bun build`.
# SQLite and the projects' context live under /data: mount a volume or disk there.
# The connections people may turn on are read from /opt/chiefbot/connections at start,
# and the template catalog from /opt/chiefbot/templates.
# Engineers' template stacks (apps/control/src/templates/stacks.ts) need the docker
# CLI with its compose and buildx plugins, on CHIEFBOT_DOCKER_SOCKET, and git to fetch
# a service's repo. The CLI and plugins are the official image's static binaries.
FROM docker:29.9.1-cli AS docker

FROM oven/bun:1-slim AS bundle
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts --production --filter @chiefbot/control && bun build apps/control/src/index.ts --target=bun --outfile /out/control.js

FROM oven/bun:1-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
COPY --from=bundle /out/control.js /opt/chiefbot/control.js
COPY connections /opt/chiefbot/connections
COPY templates /opt/chiefbot/templates
ENV CHIEFBOT_DB_PATH=/data/control.sqlite CHIEFBOT_CONNECTIONS_DIR=/opt/chiefbot/connections CHIEFBOT_TEMPLATES_DIR=/opt/chiefbot/templates
CMD ["bun", "/opt/chiefbot/control.js"]
