#!/bin/sh
# Installed as /usr/local/bin/dtctl in front of the real one (install.sh). It
# refuses the two flags a read could misuse: --config, which would replace the
# config DTCTL_CONFIG names and could send the token to another URL, and
# --spill-to, which writes results outside the turn's folder. A large result
# still spills, to the turn's folder (HOME), and `dtctl inspect` reads it.
for arg in "$@"; do
  case "$arg" in
    --config | --config=* | --spill-to | --spill-to=*)
      echo "dtctl: ${arg%%=*} is turned off on this computer" >&2
      exit 2
      ;;
  esac
done
exec /usr/local/lib/dtctl/dtctl "$@"
