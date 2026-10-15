# The bot computer: one container (later one VM) per bot. Build with
# `bun run computer:build` from the repo root, which bundles the worker into
# dist/worker.js and pins the Copilot SDK in dist/package.json first. start.sh
# brings up the screen (Xvfb, Openbox, Chromium, x11vnc on loopback) and then
# runs the worker.
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

# The Copilot SDK and its bundled runtime for this image's CPU (linux-arm64 or
# linux-x64), owned by root so the bot cannot change them. Bun also installs the
# musl runtime (it cannot tell libc apart); this Debian image needs only glibc's.
COPY dist/package.json /opt/chiefbot/package.json
RUN cd /opt/chiefbot \
  && bun install --production \
  && rm -rf node_modules/@github/copilot-sdk-linuxmusl-* /root/.bun/install/cache

COPY dist/worker.js dist/git-credential.js /opt/chiefbot/
COPY start.sh /opt/chiefbot/start.sh

# Git asks the worker for the owner's short-lived GitHub token on every
# github.com request (apps/worker/src/gitCredential.ts); no token is stored.
RUN git config --system credential.https://github.com.helper '!bun /opt/chiefbot/git-credential.js' \
  && git config --system user.name "Chiefbot" \
  && git config --system user.email "chiefbot@users.noreply.github.com"

USER bot
WORKDIR /home/bot/workspace
CMD ["/opt/chiefbot/start.sh"]
