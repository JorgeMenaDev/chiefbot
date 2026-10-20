---
name: looker
description: Check Looker's health (recent query errors, failing schedules, database connection tests) and read its dashboards, Looks and users through the Looker API with the looker command. Use when the user mentions Looker, a Looker dashboard, Look, schedule, explore or database connection, or says Looker queries are failing.
---

# Looker with the looker command

The `looker` command calls the Looker API 4.0 as the user, for this turn only: it signs in with their API client ID and secret on every run and prints the JSON response. Never print the secret or copy it anywhere.

```sh
looker get <path>                       # the instance, users, connections, schedules, dashboards, Looks, models, folders
looker activity '<query json>'          # a System Activity query
looker test-connection <name>           # check Looker can connect to a database
looker request <method> <path> ['<json>']   # anything else
```

A `<path>` is an API path that starts with `/`. Quote it when it has a query string: `looker get '/connections?fields=name,dialect_name'`. Add `fields=` to keep large answers short.

These run without asking: `looker get` (only `/versions`, `/user`, `/running_queries`, and `/users`, `/connections`, `/scheduled_plans`, `/dashboards`, `/looks`, `/lookml_models` and `/folders` with or without an id), `looker activity` (only `"model":"system__activity"`) and `looker test-connection`. Everything else goes through `looker request` and waits for the user's approval in the chat: other reads, running a Look or a query on the user's own models (that can rebuild derived tables in their database), and every change (`POST`, `PUT`, `PATCH`, `DELETE`). Say what you are about to do first, and make one request per command.

## Health checks

Whether the instance answers, and who you are signed in as:

```sh
looker get /versions
looker get '/user?fields=id,display_name,email'
```

Recent query errors, from System Activity (the History explore, status `error`; the user needs the `see_system_activity` permission):

```sh
looker activity '{"model":"system__activity","view":"history","fields":["history.created_time","history.source","history.connection_name","query.model","query.view","history.message"],"filters":{"history.status":"error","history.created_time":"24 hours"},"sorts":["history.created_time desc"],"limit":"50"}'
```

Count them by connection to see whether one database is the cause: fields `["history.connection_name","history.query_run_count"]`, same filters.

Schedules that failed:

```sh
looker activity '{"model":"system__activity","view":"scheduled_plan","fields":["scheduled_job.finalized_time","scheduled_plan.id","scheduled_plan.name","scheduled_job.status_detail"],"filters":{"scheduled_job.status":"failure","scheduled_job.finalized_time":"7 days"},"sorts":["scheduled_job.finalized_time desc"],"limit":"50"}'
```

Database connections: list them, then check Looker can connect to each one. The answer has the `connect` test's status and message. The full test suite (`looker request PUT '/connections/<name>/test'`) can create views or tables to probe the database, so it asks first:

```sh
looker get '/connections?fields=name,dialect_name,host'
looker test-connection <name>
```

Queries running now: `looker get /running_queries`.

When errors pile up on one connection and its test fails, the database (or Looker's access to it) is the cause. When the test passes, look at `history.message` for the failing models and explores instead.

Reference: https://cloud.google.com/looker/docs/reference/looker-api/latest
