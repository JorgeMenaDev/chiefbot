#!/usr/bin/env bash
# Starts or removes one copy of the stack, as compose project acme-<name>.
#   ./stack.sh up <name> [--publish]   build, start, and wait until every service is healthy
#   ./stack.sh down <name>             remove the copy with its volumes
# --publish also maps the UI (3000) and the gateway (8081) to this machine's localhost.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  echo "usage: $0 up <name> [--publish] | down <name>" >&2
  exit 2
}
[[ $# -ge 2 && $2 =~ ^[a-z0-9][a-z0-9-]*$ ]] || usage
project=(-p "acme-$2" -f compose.yaml)
[[ ${3:-} == --publish ]] && project+=(-f compose.publish.yaml)

case $1 in
  up) docker compose "${project[@]}" up --detach --build --wait ;;
  down) docker compose "${project[@]}" --profile probe down --volumes --remove-orphans ;;
  *) usage ;;
esac
