#!/bin/sh
# Starts the bot computer: its screen, then the worker (as the main process, so
# it gets SIGTERM from tini on stop). Everything runs as user bot.
set -eu
export DISPLAY=:1

# A stop leaves the X lock behind in the container's /tmp.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xvfb :1 -screen 0 1280x800x24 -nolisten tcp &
while [ ! -e /tmp/.X11-unix/X1 ]; do sleep 0.1; done

openbox &

# Chromium comes back if the agent or the user closes it. Only when none runs:
# a second launch would just open another window in the running one. The
# container is its sandbox: with no capabilities and no-new-privileges,
# Chromium's own sandbox cannot start.
(while true; do
  pgrep -x chromium >/dev/null \
    || chromium --no-sandbox --disable-dev-shm-usage --no-first-run --start-maximized >/dev/null 2>&1 \
    || true
  sleep 2
done) &

# VNC on loopback only; -bg returns once it listens. The worker pipes it to control for each viewer.
x11vnc -display :1 -localhost -rfbport 5900 -shared -forever -nopw -quiet -bg

exec bun /opt/chiefbot/worker.js
