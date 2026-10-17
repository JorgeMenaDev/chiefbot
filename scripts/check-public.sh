#!/usr/bin/env bash
# Fails when a tracked file names a person, a company behind the project, a
# hard-coded GitHub OAuth client ID or a link to a private repository. Chiefbot
# is open source and generic: deployers bring their own GitHub App (`bun run setup`).
# Runs in `bun run check`, so CI runs it too. Add a term here when one slips in.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# A whole word, case-insensitive (POSIX ERE has no \b).
word() { printf '(^|[^[:alnum:]])%s($|[^[:alnum:]])' "$1"; }

denied=(
  "$(word jorge)" "$(word mena)" aljorgevi andesphere arketix "$(word matias)"
  '(Ov|Iv)23li[[:alnum:]]{12}' 'Iv1\.[0-9a-f]{16}'
)
args=()
for pattern in "${denied[@]}"; do args+=(-e "$pattern"); done

found=0
# This script is the one file allowed to spell the terms out.
if git grep --untracked -nIiE "${args[@]}" -- ':!scripts/check-public.sh'; then found=1; fi

# Links to the owner's repositories: only the public ones.
if git grep --untracked -nIoE 'JorgeMenaDev/[[:alnum:]_.-]+' -- ':!scripts/check-public.sh' |
  grep -vE ':JorgeMenaDev/(chiefbot|chartpilot)(\.git)?$'; then
  found=1
fi

if [ "$found" = 1 ]; then
  echo "check-public: the lines above name a person, a company, a client ID or a private link. Make them generic." >&2
  exit 1
fi
echo "check-public: no personal names, client IDs or private links."
