# Connections

A **connection** gives your own bots a command-line tool signed in as you: Jira through Atlassian's `acli`, Harness through the `harness` CLI, Google Cloud through `gcloud`. You turn one on once, with your own token, and every bot you own can use it from its next message.

Connections differ from connectors (`docs/connectors.md`): a connector is an MCP server a workspace shares with a project's agents, reached only through control's proxy; a connection is yours alone, a CLI on your bot's own computer, and it reaches nothing of a workspace.

## Turn one on

1. Open the gear menu at the bottom left of the sidebar and click **Connect apps**.
2. Click **Connect** on the app's row. The form lists the steps to get each value (the token, the roles or scopes it needs, where to find each ID), says what your bots then run without asking and what asks first, and shows help and an example under each field. Paste a token with only the access your bots need, and one that expires (below).
3. Click **Save**. The row says **On**.

**Edit** asks for every field again: control never sends a saved value back. **Disconnect** turns it off and deletes your fields. The bot's **Details** tab lists its **Connection calls**: each run of a connection's CLI, and when, added as each turn ends. A run shows as the CLI and the subcommands its `readOnly` list names (`harness get`, `acli jira workitem`), never flags or values; a command no read-only entry names shows as the bare CLI.

Each app's steps and field help live in its `connection.yaml` (below). Looker's CLI, `looker`, is a small API client the folder ships (`connections/looker/looker.ts`).

## What happens in a turn

Control keeps the plain fields in its database and the secret ones in its `SecretStore`, and sends them only with a turn of a bot whose owner turned the connection on. A connection with an `exchange` gets what the exchange makes instead of its secret: for Google Cloud, control signs a JWT with the service account's key (or uses the `authorized_user` refresh token) at Google's token endpoint before each turn, and sends only the one-hour access token, as the field `token`. If Google refuses the key, control logs why and leaves the connection out of that turn. For that turn the worker writes, under `/tmp/chiefbot` on the bot's computer:

- `connections/<name>/<field>`: one file per field, readable only by user `bot` (mode 600).
- `skills/<name>/SKILL.md`: the connection's skill, which tells the agent how to use the CLI. The Copilot SDK loads skills only from this folder.
- `bin/<cli>`: a wrapper first on the agent's PATH. It notes the run in `calls`, sets the connection's environment (the token, and a config folder inside the turn's folder), then runs the real CLI.

When the turn ends, however it ends, the worker deletes `/tmp/chiefbot`, and again when it starts. **Stop** ends a running turn at once in control (its approvals expire), and the stopping worker refuses what it still waits on and deletes `/tmp/chiefbot` before it exits. If the computer is killed instead, Docker keeps the stopped container's `/tmp`, so the files stay there until the worker starts again and clears them first. On GCE the container is removed when it stops (`docker run --rm`). `/tmp/chiefbot` is not a tmpfs: Docker mounts tmpfs `noexec`, which the wrappers cannot run from, and a mount point cannot be removed at a turn's end. Between turns there is nothing on the computer, and the Copilot runtime's own environment never holds the token.

Before a shell command runs, the worker checks each command of a connection's CLI in it against the connection's `readOnly` list. A match runs. Anything else waits for your approval: the chat shows a **Connector approval** card with the app and the command. A command whose text has the CLI's name anywhere the worker cannot see it run (`env -Sacli …`, `sh -c "…"`, even `cat acli.txt`) asks too, for the whole command: a false alarm beats a missed write. When the turn ends, approvals still pending are refused. Then the worker reads the runs the wrapper noted, once, and sends them to control on its connection, just before the message that ends the turn; control logs them under that turn (`GET /bots/:id/connection-calls`). So a declined command, or one that never ran, is not logged, and the log fills in when the turn ends, not while it runs. The agent can write that file, so the worker reads at most its first 256 KB and 500 runs, only if it is a regular file, and never waits on it: anything wrong logs fewer calls, never a stuck turn. Control takes calls only for a turn of that bot that has not ended.

## Health

**Health**, at the top of the sidebar, shows whether the apps behind your connections are well, without asking a bot. For each connection that is on and has a probe, control runs fixed read-only API calls with your saved fields within a minute of you turning it on, then every 5 minutes, and when you click **Refresh**. No AI runs, and nothing reaches a bot's computer.

- Google Cloud: the project's Cloud Run services and GKE clusters, and the open incidents on Google's status page in the regions they run in. The setup's viewer roles cover it.
- Dynatrace: open problems, from a DQL query on `dt.davis.problems` through the Grail query API, with the setup's `storage:events:read` and `storage:buckets:read` scopes.
- Looker: whether the instance answers and signs you in, then two System Activity queries: query errors in the last hour, and failed schedule deliveries in 24 hours. They need `see_system_activity`. The secret and the session token are cut out of everything Looker sends back, as the `looker` CLI does (`connections/looker/redact.ts`).

Each check is ok, degraded, down or unknown. Unknown means the check could not run (a refused key, a missing permission, an API that is off, a region or zone Google could not list, no answer in 30 seconds), with the reason, and is never ok. Control runs at most 4 scheduled checks at once. A check still running when you save the connection again or turn it off, or when control stops, is aborted and its result dropped. Control keeps each connection's checks for 24 hours, and deletes them when you turn it off. A card shows them as a bar, and each problem has **Ask my bot**, which opens your last bot with a message about it ready to send.

A probe is code, not YAML: a function in `apps/control/src/health/`, listed in `defaultProbes`. A connection without one is not on the screen.

## Security position

Approvals here are a guardrail against mistakes, not a boundary.

The credential is yours and the computer is your bot's, which acts only for you (`docs/isolation.md`). During a turn the agent can read the token file, run the CLI from a script, or call the vendor's API with the token directly, and the worker sees none of that as a command of the CLI. So a bot can do anything your token allows, as you could in your own terminal. That is why the screen asks for a token that expires, with only the access it needs: a Harness token or service account with viewer roles, a Dynatrace token with read scopes, a Google service account with viewer roles. acli signs in only with an Atlassian API token without scopes, which can do whatever its account can, so for Jira the account itself is the limit. The token is on the computer only while your turn runs. Google Cloud's is a one-hour access token: the key it comes from stays in control.

Connections reach only your own bots. A project's coordinator has no shell, and task workers do not get connections.

## Add one

A connection is a folder, `connections/<name>/`, with three files. Control reads every folder when it starts (`CHIEFBOT_CONNECTIONS_DIR`, default the repo's `connections`) and refuses to start if one is wrong; the computer image runs every `install.sh`. No code changes.

`connection.yaml`:

| Key | Meaning |
| --- | --- |
| `title`, `description` | What **Connect apps** shows. The folder name is the connection's name: lower-case letters, digits and hyphens. |
| `cli` | The command the agent runs, which gets the wrapper. |
| `setup` | 3 to 6 steps **Connect apps** numbers above the fields: how to get each value, and the roles or scopes it needs, read-only first. A step (or a field's `help`) may hold one link, written `[text](https://…)`, which opens in the system browser. |
| `withoutAsking`, `asksFirst` | One line each, in words: what the bot runs without asking (the `readOnly` list) and what waits for approval. |
| `fields` | What the person fills in: `<field>: { label, secret, help, placeholder }`. A `secret` field is a password input and is kept in the `SecretStore`. `help` shows under the input (what it is, where to get it); `placeholder` is an example value. |
| `env` | Variables the wrapper sets. `{field}` is a field's value, `{dir}` the connection's folder for the turn. Point the CLI's config and login there, so they go with the turn. |
| `exchange` | Optional. `google-access-token`: control turns the secret field `key` into the field `token`, a one-hour Google access token, before each turn; the key never reaches the computer. |
| `readOnly` | Commands that run without asking. `*` matches any text, `?` one character, and the whole command must match. Leave out anything that may write. |

`SKILL.md` starts with frontmatter whose `name` is the folder name, and says how to sign in (if the CLI needs it, from the files in `/tmp/chiefbot/connections/<name>/`), what reads and what changes things.

`install.sh` runs as root when the image is built and puts the CLI on the PATH. Pin its version and check its SHA-256, as Jira's, Harness's and gcloud's do. Rebuild the image (`bun run computer:build`) and recreate bots to get it.
