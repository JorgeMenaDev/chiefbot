# The bot computer: one container (later one VM) per bot. Build with
# `bun run computer:build` from the repo root, which bundles the worker into
# dist/worker.js first. start.sh brings up the screen (Xvfb, Openbox, Chromium,
# x11vnc on loopback) and then runs the worker.
FROM oven/bun:1-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
     xvfb openbox x11vnc chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

# The bot's home is its own named volume (mounted at /home/bot by the
# ComputerProvider). A new volume copies this directory, owner included.
# Chromium's profile lives there too, so logins survive restarts.
RUN useradd --create-home --home-dir /home/bot --shell /bin/bash bot \
  && mkdir /home/bot/workspace \
  && chown bot:bot /home/bot/workspace \
  && mkdir -m 1777 -p /tmp/.X11-unix

COPY dist/worker.js /opt/chiefbot/worker.js
COPY start.sh /opt/chiefbot/start.sh

USER bot
WORKDIR /home/bot/workspace
CMD ["/opt/chiefbot/start.sh"]
