---
name: dynatrace
description: Check service health in Dynatrace with the dtctl command - open problems, error logs, failing services, SLOs - and run DQL queries. Use when the user mentions Dynatrace, DQL, a problem ID like P-12345, or asks whether a service is up, erroring or slow.
---

# Dynatrace with dtctl

The `dtctl` command is signed in as the user for this turn: their environment and token are in its environment. Never print the token or copy it anywhere, and don't run `dtctl ctx token` or `dtctl config view`. There is one context; don't add others.

If a command fails to connect or authenticate, run `dtctl doctor` and tell the user what it says.

Reading runs without asking: `get`, `describe`, `query`, `verify`, `logs`, `history`, `inspect`, `doctor`, `commands` and `auth status`. `dtctl commands` lists every verb and resource. Add `--agent` for a JSON answer (`{ok, result, context}`); a large query result is saved to a file, and `dtctl inspect <path> --head 20` reads it without querying again. Always bound DQL with `from:`, since log queries bill by bytes scanned.

## Health checks

Open problems:

```sh
dtctl query 'fetch dt.davis.problems, from:now()-24h | filter not(dt.davis.is_duplicate) and event.status == "ACTIVE" | fields event.start, display_id, event.name, event.category, root_cause_entity_name | sort event.start desc | limit 20'
```

One problem in full: `dtctl query 'fetch dt.davis.problems, from:now()-7d | filter display_id == "P-12345" | fields event.start, event.end, event.name, event.description, root_cause_entity_name, affected_entity_ids'`

Error logs in the last hour, most frequent first:

```sh
dtctl query 'fetch logs, from:now()-1h | filter loglevel == "ERROR" | summarize errors = count(), by:{dt.service.name} | sort errors desc | limit 20'
dtctl query 'fetch logs, from:now()-1h | filter loglevel == "ERROR" | fields timestamp, dt.service.name, content | sort timestamp desc | limit 50'
```

Service health in the last hour (requests, failure rate, p95 in ms), worst first:

```sh
dtctl query 'timeseries { requests = sum(dt.service.request.count, scalar: true), failures = sum(dt.service.request.failure_count, scalar: true), p95 = percentile(dt.service.request.response_time, 95, scalar: true) }, by:{dt.service.name}, from:now()-1h | fieldsAdd failure_pct = failures * 100.0 / requests, p95_ms = p95 / 1000 | sort failure_pct desc | limit 20'
```

For one service, add `| filter dt.service.name == "checkout"` after `timeseries …`.

SLOs: `dtctl get slos -o wide` shows each one's target and status; `dtctl describe slo <id>` shows its error budget.

## Changes

Anything else waits for the user's approval in the chat: `apply`, `create`, `edit`, `update`, `delete`, `exec` (running a workflow, an analyzer, an SLO evaluation, CoPilot), `share`, `restore`, `config` and `auth login`. Say what you are about to do first, and run one change per command so the user approves exactly that.

Reference: https://github.com/dynatrace-oss/dtctl/blob/main/docs/QUICK_START.md
