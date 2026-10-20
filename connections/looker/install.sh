#!/bin/sh
# Installs looker, this folder's Looker API client, at image build (run as root).
# It is a Bun script and the computer image is Bun's, so there is nothing to
# download or pin: the script is the version in this commit.
set -eu
install -m 755 "$(dirname "$0")/looker.ts" /usr/local/bin/looker
