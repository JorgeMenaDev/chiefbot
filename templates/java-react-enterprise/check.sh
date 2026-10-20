#!/usr/bin/env bash
# The two-copy check. It starts two copies of the stack at once and, in each, runs
# a real browser inside that copy's network namespace: it logs in, sees the seeded
# records and creates one. Then it checks that neither copy sees the other's
# record, and removes both copies. Needs Docker, so `bun run check` leaves it out.
set -euo pipefail
cd "$(dirname "$0")"
export COMPOSE_PROGRESS=quiet
copies=(check-a check-b)

finish() {
  local status=$?
  for copy in "${copies[@]}"; do
    ((status == 0)) || docker compose -p "acme-$copy" logs --tail 30 || true
    ./stack.sh down "$copy" || true
  done
  echo "removed both copies; left behind: $(docker ps -aq --filter name=acme-check- | wc -l | tr -d ' ') containers," \
    "$(docker volume ls -q --filter name=acme-check- | wc -l | tr -d ' ') volumes"
  ((status == 0)) && echo "check: passed" || echo "check: FAILED"
  exit "$status"
}
trap finish EXIT

# Runs one step for both copies at once, each line prefixed with its copy.
both() {
  local pids=() failed=0
  for copy in "${copies[@]}"; do
    "$@" "$copy" 2>&1 | sed "s/^/[$copy] /" &
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
echo "== start two copies at once"
both start
echo "== in each copy, a browser logs in, sees the seed and creates a record"
both create
echo "== neither copy sees the other's record"
both isolated
