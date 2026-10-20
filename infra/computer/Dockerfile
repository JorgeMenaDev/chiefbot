# The bot computer: one container (or VM) per bot, project coordinator and task
# worker. Build with `bun run computer:build`, or with Docker alone from the repo
# root: `docker build -f infra/computer/Dockerfile .`. The first stage bundles
# the worker into dist/worker.js and pins the Copilot SDK in dist/package.json
# (infra/computer/build.ts) and draws the wallpaper. start.sh brings up the
# screen (Xvfb, Openbox, a desktop with a dock, x11vnc on loopback) and then
# runs the worker, whose `computer` tool drives that screen with xdotool and
# sees it with scrot (apps/worker/src/computerUse.ts). The image carries every
# connection's CLI (connections/), never a connection's fields.
FROM oven/bun:1-slim AS dist
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts --production --filter @chiefbot/worker && bun infra/computer/build.ts --dist-only

FROM oven/bun:1-slim

# The desktop: hsetroot sets the wallpaper, tint2 is the dock, Thunar is Files
# and xfce4-terminal is Terminal. librsvg2-common lets GTK draw the Adwaita
# icon theme's SVG icons.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
     xvfb openbox x11vnc chromium fonts-liberation xdotool scrot \
     hsetroot tint2 thunar xfce4-terminal librsvg2-common \
  && rm -rf /var/lib/apt/lists/*

# Every connection's CLI, from its connections/<name>/install.sh (run as root,
# each pinned to a version and checked against the vendor's SHA-256). A bot's
# turn brings its owner's credential for them (apps/worker/src/connections.ts).
COPY connections /tmp/connections
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && for install in /tmp/connections/*/install.sh; do sh "$install"; done \
  && apt-get purge -y --auto-remove curl \
  && rm -rf /tmp/connections /var/lib/apt/lists/*

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
COPY --from=dist /src/infra/computer/dist/package.json /opt/chiefbot/package.json
RUN cd /opt/chiefbot \
  && bun install --production \
  && rm -rf node_modules/@github/copilot-sdk-linuxmusl-* /root/.bun/install/cache

COPY --from=dist /src/infra/computer/dist/worker.js /src/infra/computer/dist/git-credential.js /src/infra/computer/dist/wallpaper.png /opt/chiefbot/
COPY infra/computer/start.sh /opt/chiefbot/start.sh
COPY infra/computer/dock /opt/chiefbot/dock
COPY infra/computer/chromium-flags /etc/chromium.d/chiefbot

# Git here gets no GitHub token. The worker points the
# agent's git at control's git proxy for github.com (GIT_CONFIG_* variables,
# apps/worker/src/gitProxy.ts), whose credential helper hands git the bot's
# credential; control asks the user before every push. gh is not installed.
RUN git config --system user.name "Chiefbot" \
  && git config --system user.email "chiefbot@users.noreply.github.com"

USER bot
WORKDIR /home/bot/workspace
CMD ["/opt/chiefbot/start.sh"]
