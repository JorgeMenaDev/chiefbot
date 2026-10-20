#!/usr/bin/env bash
# The two-copy check. It starts two copies of the stack at once and, in each, runs
# a real browser inside that copy's network namespace: it logs in, proves the
# gateway's cookie alone authenticates, sees every seeded record and creates one.
# Then it checks that neither copy sees the other's record, and removes both
# copies. Needs Docker, so `bun run check` leaves it out.
set -euo pipefail
cd "$(dirname "$0")"
export COMPOSE_PROGRESS=quiet

# Names no other stack has, so this run removes only what it made.
run=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
copies=("check-$run-a" "check-$run-b")
started=()

finish() {
  local status=$? copy project filter left
  for copy in ${started[@]+"${started[@]}"}; do
    project="acme-$copy"
    ((status == 0)) || docker compose -p "$project" logs --tail 30 || true
    ./stack.sh down "$copy" || status=1
    filter="label=com.docker.compose.project=$project"
    if ! left=$(docker ps -aq --filter "$filter" && docker volume ls -q --filter "$filter" &&
      docker network ls -q --filter "$filter"); then
      echo "could not list what $project left behind" >&2
      status=1
    elif [[ -n $left ]]; then
      echo "teardown left containers, volumes or networks of $project behind" >&2
      status=1
    fi
  done
  ((status == 0)) && echo "removed both copies, nothing left behind" && echo "check: passed" || echo "check: FAILED"
  exit "$status"
}
trap finish EXIT

# Runs one step for both copies at once, each line prefixed with its copy.
both() {
  local pids=() failed=0 copy pid
  for copy in "${copies[@]}"; do
    "$@" "$copy" 2>&1 | sed "s/^/[${copy##*-}] /" &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
  return "$failed"
}
other() { [[ $1 == "${copies[0]}" ]] && echo "${copies[1]}" || echo "${copies[0]}"; }
probe() { docker compose -p "acme-$1" --profile probe run --rm --no-deps probe "${@:2}"; }

start() {
  local began=$SECONDS
  ./stack.sh up "$1"
  echo "ready in $((SECONDS - began))s"
  docker compose -p "acme-$1" logs --no-log-prefix seed
}
create() { probe "$1" create "record-from-$1"; }
isolated() { probe "$1" isolated "record-from-$1" "record-from-$(other "$1")"; }

echo "== build the images from source"
docker compose --profile probe build
echo "== start two copies at once: acme-${copies[0]} and acme-${copies[1]}"
started=("${copies[@]}")
both start
echo "== in each copy, a browser logs in, uses the auth cookie alone, sees the seed and creates a record"
both create
echo "== neither copy sees the other's record"
both isolated
