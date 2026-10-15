# The bot computer: one container (later one VM) per bot. Build with
# `bun run computer:build` from the repo root, which bundles the worker into
# dist/worker.js and pins the Copilot SDK in dist/package.json first.
# Ticket #5 adds Xvfb, Chromium and noVNC.
FROM oven/bun:1-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The bot's home is its own named volume (mounted at /home/bot by the
# ComputerProvider). A new volume copies this directory, owner included.
RUN useradd --create-home --home-dir /home/bot --shell /bin/bash bot \
  && mkdir /home/bot/workspace \
  && chown bot:bot /home/bot/workspace

# The Copilot SDK and its bundled runtime for this image's CPU (linux-arm64 or
# linux-x64), owned by root so the bot cannot change them. Bun also installs the
# musl runtime (it cannot tell libc apart); this Debian image needs only glibc's.
COPY dist/package.json /opt/chiefbot/package.json
RUN cd /opt/chiefbot \
  && bun install --production \
  && rm -rf node_modules/@github/copilot-sdk-linuxmusl-* /root/.bun/install/cache

COPY dist/worker.js /opt/chiefbot/worker.js

USER bot
WORKDIR /home/bot/workspace
CMD ["bun", "/opt/chiefbot/worker.js"]
