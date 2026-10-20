#!/usr/bin/env bash
# Starts or removes one copy of the stack, as compose project acme-<name>.
#   ./stack.sh up <name> [--publish]   build, start, and wait until every service is healthy
#   ./stack.sh down <name>             remove the copy with its volumes
# --publish also maps the UI (3000) and the gateway (8081) to this machine's localhost.
# A start that fails removes what it created. A copy that existed before is left as it is.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  echo "usage: $0 up <name> [--publish] | down <name>" >&2
  exit 2
}
[[ $# -ge 2 && $2 =~ ^[a-z0-9][a-z0-9-]*$ ]] || usage
name="acme-$2"
project=(-p "$name" -f compose.yaml)
[[ ${3:-} == --publish ]] && project+=(-f compose.publish.yaml)

# Containers and volumes compose made for this copy, running or not.
owned() {
  docker ps -aq --filter "label=com.docker.compose.project=$name"
  docker volume ls -q --filter "label=com.docker.compose.project=$name"
}

case $1 in
  up)
    existed=$(owned)
    docker compose "${project[@]}" up --detach --build --wait && exit 0
    if [[ -n $existed ]]; then
      echo "$name did not start. It existed before, so it is left as it is." >&2
    else
      echo "$name did not start. Removing what this start created." >&2
      docker compose "${project[@]}" --profile probe down --volumes --remove-orphans >&2 || true
    fi
    exit 1
    ;;
  down) docker compose "${project[@]}" --profile probe down --volumes --remove-orphans ;;
  *) usage ;;
esac
