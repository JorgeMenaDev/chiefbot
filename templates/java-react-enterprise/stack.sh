#!/usr/bin/env bash
# Starts or removes one copy of the stack, as compose project acme-<name>.
#   ./stack.sh up <name> [--publish]   build, start, and wait until every service is healthy
#   ./stack.sh down <name>             remove the copy with its volumes
# --publish also maps the UI (3000) and the gateway (8081) to this machine's localhost.
# A start that fails or is interrupted removes what it created. A copy that existed
# before is left as it is. One command at a time per copy: a second one fails at once.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  echo "usage: $0 up <name> [--publish] | down <name>" >&2
  exit 2
}
[[ $# -ge 2 && $2 =~ ^[a-z0-9][a-z0-9-]*$ && $1 =~ ^(up|down)$ ]] || usage
name="acme-$2"
project=(-p "$name" -f compose.yaml)
[[ ${3:-} == --publish ]] && project+=(-f compose.publish.yaml)

tmp=${TMPDIR:-/tmp}
lock="${tmp%/}/$name.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "$name: another start or removal is running. If none is, remove $lock." >&2
  exit 1
fi

compose="" # the running `compose up`, while there is one
before=""  # "new" or "existing" once known: the copy before this start

# Runs on every exit, including INT, TERM and a failed command. A start of a new
# copy that did not finish stops compose, waits for it, then removes what it made.
finish() {
  local status=$?
  trap - EXIT INT TERM ERR
  if [[ -n $compose ]]; then
    kill -TERM "$compose" 2>/dev/null || true
    wait "$compose" 2>/dev/null || true
  fi
  if ((status != 0)) && [[ $before == new ]]; then
    echo "$name did not start. Removing what this start created." >&2
    docker compose "${project[@]}" --profile probe down --volumes --remove-orphans >&2 || status=1
  elif ((status != 0)) && [[ $before == existing ]]; then
    echo "$name did not start. It existed before, so it is left as it is." >&2
  fi
  rmdir "$lock"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 1' ERR

if [[ $1 == down ]]; then
  docker compose "${project[@]}" --profile probe down --volumes --remove-orphans
  exit 0
fi

# What compose already made for this copy, running or not. A failed query stops here.
filter="label=com.docker.compose.project=$name"
existed=$(docker ps -aq --filter "$filter" && docker volume ls -q --filter "$filter" &&
  docker network ls -q --filter "$filter") || {
  echo "$name: could not list its containers, volumes and networks." >&2
  exit 1
}
[[ -z $existed ]] && before=new || before=existing

# In the background, so a signal reaches the trap now, not when compose ends.
docker compose "${project[@]}" up --detach --build --wait &
compose=$!
wait "$compose"
compose=""
