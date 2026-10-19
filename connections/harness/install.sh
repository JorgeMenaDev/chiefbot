#!/bin/sh
# Installs the harness CLI (github.com/harness/cli) at image build (run as root).
# Pinned: the core binary from its GitHub release, checked against the SHA-256 in
# that release's harness_<version>_checksums.txt.
set -eu
version=3.9.0
arch=$(dpkg --print-architecture)
case "$arch" in
  amd64) sha256=48c3b537af8c1f9a02e823a5b332dc3aeda130f4844ea3631b6eb6fe5b8f2b01 ;;
  arm64) sha256=7ff6211fb2e5d137dfed8c6b1ce1f2b3826458b48aaa6e3105f7c25062bafe02 ;;
  *) echo "harness has no Linux build for $arch" >&2; exit 1 ;;
esac
archive="/tmp/harness-core_${version}_linux_${arch}.tar.gz"
curl -fsSLo "$archive" "https://github.com/harness/cli/releases/download/v${version}/$(basename "$archive")"
echo "$sha256  $archive" | sha256sum -c -
tar -xzf "$archive" -C /usr/local/bin harness
rm "$archive"
