---
name: jira
description: Read and change Jira work items (issues) with the acli command. Use when the user mentions Jira, tickets, work items, issue keys like ABC-123, sprints or boards.
---

# Jira with acli

The user's Jira credential is in `/tmp/chiefbot/connections/jira/` (`site`, `email`, `token`) for this turn only. Never print the token or copy it anywhere.

Sign in once per turn, before the first other `acli` command:

```sh
acli jira auth login --site "$(cat /tmp/chiefbot/connections/jira/site)" --email "$(cat /tmp/chiefbot/connections/jira/email)" --token < /tmp/chiefbot/connections/jira/token
```

If the site has `https://` in front, leave it out of `--site`.

Reading runs without asking:

- `acli jira workitem search --jql "assignee = currentUser() AND resolution = EMPTY" --limit 20`
- `acli jira workitem view KEY-123` (add `--json` for every field)
- `acli jira project list`

Changing anything waits for the user's approval in the chat: `acli jira workitem create`, `edit`, `transition`, `assign`, `comment create` and the rest. Say what you are about to do before you run it, and run one change per command so the user approves exactly that.

Reference: https://developer.atlassian.com/cloud/acli/reference/commands/
