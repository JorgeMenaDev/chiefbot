---
name: harness
description: Read Harness pipelines, executions, services and logs, and run pipelines, with the harness command. Use when the user mentions Harness, a Harness pipeline, a deployment or a build in Harness.
---

# Harness with the harness CLI

The `harness` command is signed in as the user for this turn: their token is in its environment. Never print it or copy it anywhere.

Commands run in the user's default organisation and project (`harness auth status` shows them). For another one, add `--org <org> --project <project>`; `harness list org` and `harness list project --org <org>` find them.

Reading runs without asking:

- `harness list pipeline`
- `harness get pipeline <id>`
- `harness list execution --limit 10`
- `harness get execution <pipeline>/<execution id>`

Add `--format json` when you need to read fields. Anything else (`execute`, `create`, `update`, `delete`) waits for the user's approval in the chat: say what you are about to do first.

Reference: https://developer.harness.io/harness-platform/use-harness-cli/harness-cli/install-and-upgrade
