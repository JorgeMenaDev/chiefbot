#!/bin/sh
# Installs dtctl, Dynatrace's CLI (github.com/dynatrace-oss/dtctl), at image build
# (run as root). Pinned: the binary from its GitHub release, checked against the
# SHA-256 in that release's checksums.txt.
# Also writes the config the wrapper points DTCTL_CONFIG at (connection.yaml):
# one context whose URL and token dtctl reads from the environment when it loads
# the file. It holds no secret, and the bot cannot change it.
set -eu
version=0.43.0
arch=$(dpkg --print-architecture)
case "$arch" in
  amd64) sha256=23c1e133da5d585b1399f59cfca78cfe89d9f9f4659e2a9e64a31c4e6b0074f3 ;;
  arm64) sha256=e9c0984523ee3a651ababda8bb492df5181a410979dbb76fcd6a1ed74f9bce39 ;;
  *) echo "dtctl has no Linux build for $arch" >&2; exit 1 ;;
esac
archive="/tmp/dtctl_${version}_linux_${arch}.tar.gz"
curl -fsSLo "$archive" "https://github.com/dynatrace-oss/dtctl/releases/download/v${version}/$(basename "$archive")"
echo "$sha256  $archive" | sha256sum -c -
tar -xzf "$archive" -C /usr/local/bin dtctl
rm "$archive"
mkdir -p /etc/dtctl
cat > /etc/dtctl/config.yaml <<'CONFIG'
apiVersion: v1
current-context: chiefbot
contexts:
  - name: chiefbot
    context:
      environment: ${DT_ENVIRONMENT_URL}
      token-ref: chiefbot
tokens:
  - name: chiefbot
    token: ${DT_API_TOKEN}
CONFIG
chmod 644 /etc/dtctl/config.yaml
