# Connections

A **connection** gives your own bots a command-line tool signed in as you: Jira through Atlassian's `acli`, Harness through the `harness` CLI. You turn one on once, with your own token, and every bot you own can use it from its next message.

Connections differ from connectors (`docs/connectors.md`): a connector is an MCP server a workspace shares with a project's agents, reached only through control's proxy; a connection is yours alone, a CLI on your bot's own computer, and it reaches nothing of a workspace.

## Turn one on

1. Open the gear menu at the bottom left of the sidebar and click **Connect apps**.
2. Click **Connect** on the app's row and fill in its fields. Paste a token with only the access your bots need, and one that expires (below).
3. Click **Save**. The row says **On**.

**Edit** asks for every field again: control never sends a saved value back. **Disconnect** turns it off and deletes your fields. The bot's **Details** tab lists its **Connection calls**: each run of a connection's CLI, and when, added as each turn ends. A run shows as the CLI and the subcommands its `readOnly` list names (`harness get`, `acli jira workitem`), never flags or values; a command no read-only entry names shows as the bare CLI.

| App | Fields |
| --- | --- |
| Jira | Site (like `mysite.atlassian.net`), your Atlassian email, an API token (id.atlassian.com, **Security**, **API tokens**; pick one with scopes and an expiry date). |
| Harness | Account ID, a default organization and project (the CLI refuses to run without them; `--org` and `--project` still choose another per command), and a personal access token or service account token with only the roles it needs. |

## What happens in a turn

Control keeps the plain fields in its database and the secret ones in its `SecretStore`, and sends them only with a turn of a bot whose owner turned the connection on. For that turn the worker writes, under `/tmp/chiefbot` on the bot's computer:

- `connections/<name>/<field>`: one file per field, readable only by user `bot` (mode 600).
- `skills/<name>/SKILL.md`: the connection's skill, which tells the agent how to use the CLI. The Copilot SDK loads skills only from this folder.
- `bin/<cli>`: a wrapper first on the agent's PATH. It notes the run in `calls`, sets the connection's environment (the token, and a config folder inside the turn's folder), then runs the real CLI.

When the turn ends, however it ends, the worker deletes `/tmp/chiefbot`, and again when it starts. Between turns there is nothing on the computer, and the Copilot runtime's own environment never holds the token.

Before a shell command runs, the worker checks each command of a connection's CLI in it against the connection's `readOnly` list. A match runs. Anything else waits for your approval: the chat shows a **Connector approval** card with the app and the command. A command whose text has the CLI's name anywhere the worker cannot see it run (`env -Sacli …`, `sh -c "…"`, even `cat acli.txt`) asks too, for the whole command: a false alarm beats a missed write. When the turn ends, approvals still pending are refused. Then the worker reads the runs the wrapper noted, once, and sends them to control on its connection, just before the message that ends the turn; control logs them under that turn (`GET /bots/:id/connection-calls`). So a declined command, or one that never ran, is not logged, and the log fills in when the turn ends, not while it runs. The agent can write that file, so the worker reads at most its first 256 KB and 500 runs, only if it is a regular file, and never waits on it: anything wrong logs fewer calls, never a stuck turn. Control takes calls only for a turn of that bot that has not ended.

## Security position

Approvals here are a guardrail against mistakes, not a boundary.

The credential is yours and the computer is your bot's, which acts only for you (`docs/isolation.md`). During a turn the agent can read the token file, run the CLI from a script, or call the vendor's API with the token directly, and the worker sees none of that as a command of the CLI. So a bot can do anything your token allows, as you could in your own terminal. That is why the screen asks for a scoped token that expires: an Atlassian API token with scopes, a Harness token or service account with only the roles it needs. The token is on the computer only while your turn runs.

Connections reach only your own bots. A project's coordinator has no shell, and task workers do not get connections.

## Add one

A connection is a folder, `connections/<name>/`, with three files. Control reads every folder when it starts (`CHIEFBOT_CONNECTIONS_DIR`, default the repo's `connections`) and refuses to start if one is wrong; the computer image runs every `install.sh`. No code changes.

`connection.yaml`:

| Key | Meaning |
| --- | --- |
| `title`, `description` | What **Connect apps** shows. The folder name is the connection's name: lower-case letters, digits and hyphens. |
| `cli` | The command the agent runs, which gets the wrapper. |
| `fields` | What the person fills in: `<field>: { label, secret }`. A `secret` field is a password input and is kept in the `SecretStore`. |
| `env` | Variables the wrapper sets. `{field}` is a field's value, `{dir}` the connection's folder for the turn. Point the CLI's config and login there, so they go with the turn. |
| `readOnly` | Commands that run without asking. `*` matches any text, `?` one character, and the whole command must match. Leave out anything that may write. |

`SKILL.md` starts with frontmatter whose `name` is the folder name, and says how to sign in (if the CLI needs it, from the files in `/tmp/chiefbot/connections/<name>/`), what reads and what changes things.

`install.sh` runs as root when the image is built and puts the CLI on the PATH. Pin its version and check its SHA-256, as Jira's and Harness's do. Rebuild the image (`bun run computer:build`) and recreate bots to get it.
