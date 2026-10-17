# The control plane for GCP: one container on the chiefbot-control VM (see
# infra/gcp and docs/deploy-gcp.md). dist/control.js is apps/control bundled
# with `bun build`. SQLite lives on the VM's data disk, mounted at /data.
FROM oven/bun:1-slim

COPY dist/control.js /opt/chiefbot/control.js

ENV CHIEFBOT_DB_PATH=/data/control.sqlite
CMD ["bun", "/opt/chiefbot/control.js"]
