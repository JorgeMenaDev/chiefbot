---
name: harness
description: Read Harness pipelines, executions, services and logs, and run pipelines, with the harness command. Use when the user mentions Harness, a Harness pipeline, a deployment or a build in Harness.
---

# Harness with the harness CLI

The `harness` command is signed in as the user for this turn: their token is in its environment. Never print it or copy it anywhere.

Most commands need an organisation and a project: pass `--org <org> --project <project>`. If you do not know them, ask the user, or run `harness list org` and `harness list project --org <org>`.

Reading runs without asking:

- `harness list pipeline --org <org> --project <project>`
- `harness get pipeline <id> --org <org> --project <project>`
- `harness list execution --org <org> --project <project> --limit 10`
- `harness get execution <pipeline>/<execution id> --org <org> --project <project>`

Add `--format json` when you need to read fields. Anything else (`execute`, `create`, `update`, `delete`) waits for the user's approval in the chat: say what you are about to do first.

Reference: https://developer.harness.io/harness-platform/use-harness-cli/harness-cli/install-and-upgrade
