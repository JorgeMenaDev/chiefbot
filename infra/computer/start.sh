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

# No Chromium runs yet, so a profile lock is stale (an update leaves the old computer's on the volume).
profile="$HOME/.config/chromium"
rm -f "$profile/SingletonLock" "$profile/SingletonCookie" "$profile/SingletonSocket"

# The desktop: the wallpaper (wallpaper.ts) and the dock, which opens Chromium,
# Files and Terminal (dock/tint2rc). Nothing else opens at boot: the person or
# the bot opens apps from the dock.
hsetroot -center /opt/chiefbot/wallpaper.png >/dev/null
tint2 -c /opt/chiefbot/dock/tint2rc >/dev/null 2>&1 &

# VNC on loopback only; -bg returns once it listens. The worker pipes it to control for each viewer.
x11vnc -display :1 -localhost -rfbport 5900 -shared -forever -nopw -quiet -bg

exec bun /opt/chiefbot/worker.js
