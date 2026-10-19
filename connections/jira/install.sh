#!/bin/sh
# Installs acli, the Atlassian CLI, at image build (run as root). Pinned: the
# .deb from Atlassian's apt repository, checked against the SHA-256 that the
# repository's package index lists for it
# (https://acli.atlassian.com/linux/deb/dists/stable/main/binary-<arch>/Packages).
set -eu
version=1.3.39
arch=$(dpkg --print-architecture)
case "$arch" in
  amd64) sha256=92a424beb1cd187521fb0b20165e20c600cb12dbd8d06a2bfdeec50b9e62d19b ;;
  arm64) sha256=bfd6f5be1feee2de8f2f5bf817c77bed8876e0f7972dfcff29b4e94875e968f8 ;;
  *) echo "acli has no Linux build for $arch" >&2; exit 1 ;;
esac
deb="/tmp/acli_${version}-stable_linux_${arch}.deb"
curl -fsSLo "$deb" "https://acli.atlassian.com/linux/deb/pool/stable/a/ac/$(basename "$deb")"
echo "$sha256  $deb" | sha256sum -c -
dpkg -i "$deb"
rm "$deb"
