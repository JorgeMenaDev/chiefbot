#!/bin/sh
# Starts the bot computer: its screen, then the worker (as the main process, so
# it gets SIGTERM from tini on stop). Everything runs as user bot.
set -eu
export DISPLAY=:1

# Behind a company network, control hands an engineer's computer the network's
# CA certificate (CHIEFBOT_CA_CERT, PEM; docs/deploy.md). Everything started
# from here trusts it on top of the public roots: Node and Bun add it to their
# own (NODE_EXTRA_CA_CERTS), and git, curl and OpenSSL read the system's bundle
# with it at the end. The proxy's variables come in the env as they are.
if [ -n "${CHIEFBOT_CA_CERT:-}" ]; then
  ca=/tmp/chiefbot-ca
  mkdir -p "$ca"
  printf '%s\n' "$CHIEFBOT_CA_CERT" > "$ca/ca.pem"
  cat /etc/ssl/certs/ca-certificates.crt "$ca/ca.pem" > "$ca/bundle.pem"
  export NODE_EXTRA_CA_CERTS="$ca/ca.pem" SSL_CERT_FILE="$ca/bundle.pem" CURL_CA_BUNDLE="$ca/bundle.pem" GIT_SSL_CAINFO="$ca/bundle.pem"
fi

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

# The computer's own ports (VNC_PORT), which build.ts writes from packages/contracts
# computer.ts: the worker and control's template check read the same list.
. /opt/chiefbot/ports.env

# VNC on loopback only; -bg returns once it listens. The worker pipes it to control for each viewer.
x11vnc -display :1 -localhost -rfbport "$VNC_PORT" -shared -forever -nopw -quiet -bg

exec bun /opt/chiefbot/worker.js
