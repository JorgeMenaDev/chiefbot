#!/bin/sh
# Installs gcloud, the Google Cloud CLI, at image build (run as root). Pinned: the
# versioned archive from Google's release bucket (storage.googleapis.com/cloud-sdk-release),
# checked against its SHA-256 (taken from the downloaded archives, whose MD5 matched
# the bucket's own x-goog-hash). The x86_64 archive brings its own Python; the arm
# one runs on the image's python3 (gcloud wants 3.10 to 3.15).
set -eu
version=589.0.0
arch=$(dpkg --print-architecture)
case "$arch" in
  amd64) archive=x86_64 sha256=f865da648f6fdae2015abb5b32eaa0eb10520e88f0ca735cfb33795868c8d26f ;;
  arm64) archive=arm sha256=3febb61a57ea76612973e40a2ff7bd79939161451d11130659d5c981201dca97 ;;
  *) echo "gcloud has no Linux build for $arch" >&2; exit 1 ;;
esac
tarball="/tmp/google-cloud-cli-${version}-linux-${archive}.tar.gz"
curl -fsSLo "$tarball" "https://storage.googleapis.com/cloud-sdk-release/$(basename "$tarball")"
echo "$sha256  $tarball" | sha256sum -c -
if [ "$arch" = arm64 ]; then apt-get install -y --no-install-recommends python3; fi
tar -xzf "$tarball" -C /opt
ln -s /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud
rm "$tarball"
