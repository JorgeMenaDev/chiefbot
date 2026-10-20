#!/bin/sh
# Installs looker, this folder's Looker API client, at image build (run as root).
# It is a Bun script and the computer image is Bun's, so there is nothing to
# download or pin: the script is the version in this commit. It imports
# redact.ts beside it, so both go to /usr/local/lib/looker and the command is a
# link to the script (Bun resolves the import from the link's target).
set -eu
here="$(dirname "$0")"
install -d /usr/local/lib/looker
install -m 644 "$here/redact.ts" /usr/local/lib/looker/redact.ts
install -m 755 "$here/looker.ts" /usr/local/lib/looker/looker.ts
ln -sf /usr/local/lib/looker/looker.ts /usr/local/bin/looker
