# The bot computer: one container (later one VM) per bot. Build with
# `bun run computer:build` from the repo root, which bundles the worker into
# dist/worker.js first. Ticket #5 adds Xvfb, Chromium and noVNC.
FROM oven/bun:1-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The bot's home is its own named volume (mounted at /home/bot by the
# ComputerProvider). A new volume copies this directory, owner included.
RUN useradd --create-home --home-dir /home/bot --shell /bin/bash bot \
  && mkdir /home/bot/workspace \
  && chown bot:bot /home/bot/workspace

COPY dist/worker.js /opt/chiefbot/worker.js

USER bot
WORKDIR /home/bot/workspace
CMD ["bun", "/opt/chiefbot/worker.js"]
