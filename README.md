<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg">
  <img alt="Chiefbot" src="docs/brand/lockup-light.svg" width="320">
</picture>

# Chiefbot

Personal chief-of-staff bots, each with its own computer, powered by the GitHub Copilot SDK on your own Copilot plan.

Status: proof of concept. It runs locally, with bot computers as Docker containers. For a team: `docker compose up` on one Linux machine (`compose.yaml`), or GCP with one Compute Engine VM per computer (`infra/gcp`, written but not deployed). Both, with costs and a smoke check: `docs/deploy.md`. Licence: MIT (`LICENSE`). Contributing: `CONTRIBUTING.md`. Architecture: `AGENTS.md`.

## Quickstart

You need a Mac, [Bun](https://bun.sh) 1.4 or later, Docker (Docker Desktop, OrbStack or Colima, running) and a GitHub account. Chats need GitHub Copilot on that account; Copilot Free works.

```bash
git clone https://github.com/JorgeMenaDev/chiefbot.git && cd chiefbot
bun install
bun run setup           # registers your own two GitHub Apps, then two clicks on github.com (below)
bun run computer:build  # builds the bot computer image chiefbot-computer:dev
bun run dev             # control on http://127.0.0.1:7410 and the desktop app
```

`bun run setup` registers two GitHub Apps with GitHub's App Manifest flow, one after the other:

- **The repo app** (`Chiefbot <6 hex digits>`) asks for repository contents (write) and pull requests (write), and for nothing else. Only control uses it, to reach repos for your bots.
- **The sign-in app** (`Chiefbot sign-in <6 hex digits>`) asks for no permissions. The desktop signs in with it, and its tokens are the ones your bots get for Copilot, so a token taken from a bot's computer cannot write to any repo (`docs/isolation.md`).

For each, github.com opens with the app filled in. Click **Create GitHub App** and it returns to setup. Setup saves both in `~/.chiefbot/` (folder 700, files 600, outside the repo): `config.json` with each app's ID and client ID, and `github-app-secrets.json` with the repo app's client secret and private key. Setup then prints two links:

1. The sign-in app's settings: tick **Enable Device Flow** and click **Save changes**. A manifest cannot set it, and the desktop signs in with it.
2. The repo app's install page: install it on the repositories your bots may work on. Control reaches only those for your bots.

To own the apps in an organization, run `bun run setup --org <organization>`. Both apps are private, so only the account that owns them can sign in, or, for an organization, its members. Set up before the sign-in app existed? Run `bun run setup` again: it adds only the sign-in app; then sign in again in the desktop. To start over, delete the apps on github.com and `~/.chiefbot/config.json`, then run setup again. Without a config, control and the desktop stop with "Run `bun run setup`".

**Org-billed Copilot.** A workspace's project agents (coordinators and their workers) can run on an organization's Copilot instead of each member's seat (GitHub's [server-to-server tokens](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens)). Run `bun run setup --org <organization> --org-billed-copilot`: the repo app also asks for **Copilot Requests** (write). Install it on the organization with **All repositories**, which GitHub's Copilot check needs, and turn on the organization's policy that allows Copilot requests from GitHub App installations. Already set up? Add **Copilot Requests: Read and write** to the repo app's permissions on github.com and accept the change on the installation. Then a workspace owner picks **The organization** under **Copilot for projects** on the **Members** screen. Chiefs always run on their owner's seat.

**Fallback: an OAuth App to sign in.** If the sign-in app's tokens cannot run Copilot (manual check "the sign-in token cannot write, and drives Copilot"), sign in with an OAuth App instead, which asks only for `read:user`:

1. Open github.com/settings/applications/new (for an organization: its **Settings → Developer settings → OAuth Apps → New OAuth App**).
2. Fill in any name, `https://github.com/JorgeMenaDev/chiefbot` as the homepage URL and `http://127.0.0.1/` as the callback URL (the device flow does not use it).
3. Tick **Enable Device Flow** and click **Register application**. Copy the **Client ID**. No client secret is needed.
4. Run `bun run setup --oauth-client-id <client ID>`. It keeps your repo app (or registers it first) and records the OAuth App as the sign-in app. Sign in again in the desktop: it asks GitHub for `read:user` and `offline_access`, so tokens expire after 8 hours and refresh like the sign-in app's.

In the desktop app, click **Sign in with GitHub**. Your first sign-in brings a bot named **Chief of Staff**, once: delete it and it stays deleted. **New bot** (the pen icon beside **Search** in the sidebar) adds more, each with the face and colour you pick. The sidebar hides with the button beside the window buttons, or Cmd+B. The gear at its bottom left opens a menu with your GitHub login, your Copilot plan, **Connect apps**, **Disconnect GitHub** and **Sign out**.

Timing, measured on a fresh clone on an Apple-silicon Mac: `bun install` with an empty Bun cache took 5 s and `bun run computer:build` 69 s with the `oven/bun` base image already pulled (allow about 2 minutes without it). Setup is about a minute of clicking on github.com.

Other commands: `bun run check` (typecheck, tests and the public-repo check; no network, Docker or GCP). `CHIEFBOT_COMPUTER_IMAGE` names another image tag.

## How it works

Creating a bot needs Docker and the `chiefbot-computer:dev` image. Each bot is a container `chiefbot-<bot id>` on its own network `chiefbot-<bot id>-net`, with a volume `chiefbot-<bot id>-home` mounted at `/home/bot` (its home and workspace). Its worker dials control's `/worker/<bot id>` WebSocket with a per-bot credential and the bot shows **online**. Bots cannot see each other: `docs/isolation.md`.

`CHIEFBOT_DOCKER_TESTS=1 bun test docker.live` runs the whole loop on real Docker (needs the image). `CHIEFBOT_DOCKER_TESTS=1 bun test isolation.live` shows two bots cannot read each other's volume or reach each other over the network. Both use `CHIEFBOT_COMPUTER_IMAGE` if set and remove what they create.

**Chat.** A message to a bot goes to control, which stores it and forwards it to the bot's worker. The worker runs the turn on the Copilot SDK (`@github/copilot-sdk`, pinned exactly in `apps/worker/package.json`) in `copilot-cli` mode, working in `/home/bot/workspace`. The bot has one conversation; the SDK keeps it under `/home/bot/.copilot`, so it resumes after the computer restarts. The SDK gets the user's GitHub access token from control's broker (`GET /worker/<bot id>/github-token`) through `gitHubTokenProvider`. Reply text, tool calls and status stream back to the desktop and are stored in control, so history survives a restart of any process. The image carries the SDK's bundled Linux runtime (about 170 MB of the image).

**Tokens.** The desktop signs in with your sign-in app's device flow. That app has no repository permissions, so its tokens (`ghu_…`, or `gho_…` from an OAuth App) can read who you are and your Copilot plan, and cannot write to any repo. The broker hands a bot only its owner's access token, for the Copilot SDK, with more than two hours left, never the refresh token. When less is left it refreshes with GitHub's refresh grant (device-flow tokens need no client secret), one refresh at a time per user: a refresh invalidates the old pair, so concurrent requests share it. The refresh token sits in a `SecretStore`: locally encrypted (AES-256-GCM) in control's SQLite under the key in `CHIEFBOT_SECRET_KEY_FILE`; on GCP in Secret Manager. When GitHub refuses the refresh token (expired after 6 months unused, or the app's authorization was revoked on github.com), or the user clicks **Disconnect GitHub**, control forgets the sign-in: bots get a typed `reauth_needed` refusal, their turns end with "Sign in again", and the desktop shows a **Sign in again** notice. Disconnect does not revoke the app at GitHub: an access token already handed out works until it expires, at most 8 hours, unless you revoke the sign-in app's authorization at github.com/settings/apps/authorizations.

**Model per bot.** Each bot has its own Copilot model, chosen in the composer's model picker. Once a bot's worker connects, it lists the models the owner's Copilot plan offers on the bot's SDK session and reports them to control. Control keeps the latest list per user in SQLite (`GET /models`). Picking a model saves it on the bot (`PUT /bots/:id/model`). Every turn carries the bot's model, and the worker switches the session before the turn, so the conversation is kept. On Copilot Free only Auto can be picked: the SDK accepts a switch but every turn still runs on Auto, so the other models in Copilot's catalog show as locked rows with "Needs a paid Copilot plan". On a paid plan, models a Copilot policy turns off show locked too.

**Routines.** A routine is a prompt plus a schedule: a cron expression (5 fields, or 6 with seconds) read in an IANA timezone, parsed by `croner`. The **Details** tab of a bot's panel (right of its chat) lists them, to add, edit or delete. Control runs them whether or not the desktop is open: at the due time it starts the bot's computer if it is stopped, waits up to 5 minutes for the worker, sends the prompt as a chat turn (30 minutes at most) and stops the computer again if the run started it. The reply lands in the bot's chat, and the routine shows its last run: succeeded, failed (with the reason, such as a lost GitHub sign-in) or skipped (the bot was busy, or someone had taken over its screen; no retry). A bot runs one routine at a time. Each (routine, due time) runs at most once, even across control restarts: a run cut short by a restart is marked failed and its computer stopped again, and due times missed while control was down run once when it is back.

**Connections.** **Connect apps** in the gear menu turns on command-line tools for your own bots, signed in as you: Jira (Atlassian's `acli`) and Harness (the `harness` CLI). Each is a folder under `connections/`: a definition, a skill for the agent and an install step for the computer image. Your fields go to control (secret ones to its `SecretStore`); only during a turn of one of your bots does its worker write them to `/tmp/chiefbot` with the skill and a wrapper for the CLI, and it deletes them when the turn ends. A command of the CLI that may write waits for your approval, and each one that runs shows under **Connection calls** in the bot's **Details** tab. The approval is a guardrail, not a boundary: use scoped tokens that expire. See `docs/connections.md`.

**Idle stop.** Control stops a bot's computer after 30 minutes (`CHIEFBOT_IDLE_STOP_MINUTES`) with no running turn, no pending approval, no screen viewer and no routine run in progress, with Docker and on GCP alike. **Start** in the app or a due routine starts it again. A project's coordinator computer stops the same way after 30 minutes with no turn running or queued, and the next message for it (from a member, a handoff or a subscription) starts it again.

**Repo work and approvals.** A bot clones, branches, edits and commits in its workspace without asking. Before it pushes or opens a pull request, you approve it: the chat shows an approval card (after T3 Code's) with the repo and branches or the pull request, and the bot waits until you click **Approve** or **Decline**, however long that takes. Control holds repo access, so the approval is checked outside the bot's computer (`apps/control/src/repos.ts`). Git in the bot computer reaches github.com only through control's git proxy (`/git/<owner>/<repo>.git`): the worker points the agent's git there (`apps/worker/src/gitProxy.ts`) and its credential helper hands git the running turn's key (control issues one per turn and revokes it when the turn ends: `docs/isolation.md`), never a GitHub token. Control checks, through your repo app, that your GitHub account may read the repo (or push to it), lets fetches through, and holds each push until you approve it; then it forwards exactly that push with a one-hour installation token of your repo app, scoped to that one repo. The bot's `create_pull_request` tool asks control, which opens the pull request with the same kind of token after you approve. Neither token ever reaches the bot. A repo your repo app is not installed on can be cloned only if it is public, and never pushed to. Control stores each request and answer (`POST /bots/<id>/approvals/<approval id>`), so a pending card survives a restart of the desktop and you can answer later. If control restarts while a push waits, git fails and the bot can push again (a new card); the old card stays until the turn ends and does nothing. If the bot's computer restarts first, the turn ends and the card shows **Expired**. A routine's turn waits for approvals the same way: if its 30-minute limit passes first, the run is marked failed, but the card stays answerable and the bot's computer stays running until the turn ends. Inside the computer, the worker still asks before a GitHub tool that writes (`apps/worker/src/approvals.ts`). What approvals do and do not stop: `docs/isolation.md`.

**Workspaces.** A workspace is a team. Anyone signed in can create one and is its owner. The owner invites people by GitHub login; an invite waits until someone with that login signs in to Chiefbot and accepts it from the workspace switcher at the top of the sidebar. The **Members** screen lists members and pending invites: the owner invites, withdraws invites and removes members, and a member can leave. There are two roles, owner and member, and the owner cannot leave. Removing a member, or leaving, ends at once what runs for them in the workspace's projects: their project chats close, their queued messages to coordinators go, their running coordinator turn ends, the workers they asked for stop, and control refuses every token, connector and worker request made for them. Every workspace route answers 404 to anyone who is not a member, so outsiders cannot tell a workspace exists. Projects and connectors belong to a workspace; bots stay personal.

**Projects.** A project binds one GitHub repo to a workspace. Any member creates one from the sidebar (**New project**, the folder icon beside **Search**, then `owner/repo`). Control reads the repo's `chiefbot.project.yaml` from its default branch through the GitHub API with your repo app, once it shows that member may read the repo, so the repo app must be installed on the repo (a public repo also works without it). The file is checked with a Zod schema (`ProjectFile` in `packages/contracts/src/projects.ts`); unknown keys are errors, and a missing or invalid file is refused with what is wrong and where:

```yaml
connectors: [github, jira]   # the connectors (MCP servers) its agents need, by name
commands:
  build: bun run build
  test: bun test
```

Each project gets one computer from the `ComputerProvider` (`chiefbot-<project id>`), which runs the project's **coordinator** instead of a bot worker. The coordinator plans and tracks work and never writes code: it runs the Copilot SDK in `mode: "empty"` (no shell, no files, no ambient config) with its own tools only, all served by control: `create_task`, `update_task`, `list_tasks`, `read_context` and `write_context`, the four worker tools (**Workers**, below), and the project's connectors that are ready for the member whose turn it is (`docs/connectors.md`). The **task ledger** in control's SQLite is the only record of task state (open, in progress, needs input, done, abandoned; an owner, who asked, and links to pull requests, context files or pages). **Shared context** is a set of Markdown files every agent of the project reads and adds to (`notes.md`, `docs/`, `plans/`), kept by control in a `ContextStore`: a `context` folder next to the database now, a bucket later. Each member has their own chat with the coordinator. Who pays for its Copilot is the workspace's choice (**Copilot for projects** on the **Members** screen; `PUT /workspaces/:id/copilot-mode`). By default each turn runs on the seat of the member who asked: control brokers a token only for the member whose turn is running. In org mode each turn runs on a one-hour installation token of the repo app that control mints with only `copilot_requests: write` and one repository id, billed to the account that installed the app on the project's repo; it cannot read or write any repo. The coordinator passes it to a Copilot runtime of its own as `COPILOT_GITHUB_TOKEN` with `useLoggedInUser: false` (never through `gitHubTokenProvider`, which GitHub reserves for user tokens). Each turn resumes the member's session on a runtime of its own (so every callback in it acts in that turn only: `docs/isolation.md`), started on the latest token while it has over 20 minutes left, otherwise on a new one; the conversation is kept. A turn still running five minutes before its token expires is cut short and continues on a new token and runtime with `continue`. A member's session moves between seat and organization, keeping its history, when the owner switches the mode. Org billing changes only who pays for Copilot: the project's connectors still act as the member who asked (or as the workspace, for a shared one). Each turn's chat starts with a line saying who pays (`On octo-user's Copilot seat`, `Billed to octo-org's Copilot (organization)`). Control picks the payer for every agent run in one place (`apps/control/src/copilotIdentity.ts`): chiefs always use their owner's seat. One scheduler per project runs the coordinator's turns one at a time across all members' chats, oldest first, so each turn sees the tasks the turns before it made, and two members asking for the same thing get one task. The desktop shows the ledger beside the chat and updates it live.

**Workers.** The coordinator gets a task done by dispatching a **worker**: one task on one throwaway computer (`chiefbot-worker_<id>`) from the `ComputerProvider`, result a pull request. It has four more tools for this, all served by control (`apps/control/src/taskWorkers.ts`): `dispatch_worker` (a task number and optional instructions), `worker_status`, `worker_transcript` and `stop_worker`. Control first writes a launch record keyed by a creation id, the coordinator's tool call id, and only then asks for the computer, so a resent dispatch finds the worker it started instead of making a second one. A task has at most one working worker at a time. The worker is a bot's worker on control's `/task-worker/<id>` routes: it runs the task as one turn on the Copilot SDK in `copilot-cli` mode, for the member whose message dispatched it: on that member's seat, or in org mode on the organization's installation token, as the coordinator does (control picks it in `copilotIdentity.ts`; the ledger shows who pays). In org mode a task may outlast its token's hour: five minutes before the token expires, the worker cuts the SDK turn short, fetches a new token, restarts the runtime on it, resumes the same session and sends `continue`, so the task runs on as successive SDK turns (`apps/worker/src/installationSession.ts`; the coordinator does the same). An approval the cut runtime waited on is withdrawn (its card shows **Withdrawn**), and so is one control held for a request the runtime dropped, so its wait limit cannot stop the worker. Continuing, the agent asks again if it still needs it. The project's connectors reach the worker as they reach the coordinator: through control's proxy at `/task-worker/<id>/mcp/<name>`, as the member who asked, each call logged. It clones and pushes through control's git proxy with its turn's key, and each push and its `create_pull_request` wait for that member's approval, shown as cards under the task in the ledger (`POST /projects/<id>/workers/<worker id>/approvals/<approval id>`; only that member may answer). The pull request it opens is linked on the task, and its last message becomes its result. A worker that waits on one approval for over an hour (`CHIEFBOT_APPROVAL_WAIT_MINUTES`) fails, so it costs nothing while nobody answers: control stores when each approval was asked and re-arms the limit when it restarts. Its computer stops as soon as its turn ends (finished or failed), keeping its disk, and is deleted, disk and all, when the coordinator stops it, when the task is marked done or abandoned, or when the project is deleted. A worker whose computer restarts mid-task fails. When control starts, it stops every worker computer whose turn ended but still runs, and deletes every one that should be gone (a delete that failed, or a launch the restart cut short). Workers run on the standard computer image.

**Connectors** are MCP servers a workspace defines once (GitHub, GitHub Actions and Jira are presets). A project's agents get only the connectors its `chiefbot.project.yaml` declares, each call running as the workspace's service credential or as the member who asked, and every call is logged. Each member's **Connectors** screen is their access checklist: what their projects need minus what they have connected. See `docs/connectors.md`.

**Subscriptions.** A project can listen to events: CI runs failing on a branch, new or updated results of an issue-tracker query, and schedules. Open **Listening to** in a project's header to add or remove them; any member can. Control polls CI and issue queries itself, every few minutes (5 by default, 1 at least), through a remote connector the project declares: GitHub Actions' `actions_list` for CI, GitHub's `search_issues` or Jira's `searchJiraIssuesUsingJql` for issues. Each poll runs as the workspace's credential, or for a personal connector as the member who added the subscription, and shows in **Connector calls**. A schedule is a prompt with a cron expression, run like a routine. Each event has a stable id (a CI run and its conclusion, an issue and when it was updated, a due time), stored in control, so it becomes exactly one task in the ledger and one message to the coordinator in the adding member's chat, even across control restarts. The first poll only notes what is already there. A subscription whose member leaves the workspace pauses.

**Handoffs.** Your own bot is also your chief of staff: it can hand work to a project of any workspace you belong to, and it never sees other projects. It has three tools, served by control (`POST /worker/<bot id>/chief-tools`): `list_projects`, `send_to_project` (a title, the request and an acceptance condition: how you will know it is done) and `handoff_status`. Sending creates a handoff record in control (who asked, the project, the request, the acceptance condition, the linked task) and a task in the project's ledger, asked by you. The coordinator gets it as a message in your own chat with it, through the project's scheduler, so it runs on your Copilot seat like any message of yours, queued behind one you already sent. The chief only starts and watches: the coordinator plans the work and manages its workers. A handoff's status is its task's status in the ledger. Whenever that task becomes **needs input** or **done**, control posts one notice in the chief's chat ("shop needs your input on … Answer in the project's chat", or "shop finished …" with the task's links). A repeat of the same status posts nothing; a task that goes back to in progress and needs input again posts again. If you leave the workspace, your chief sees and hears nothing more of its handoffs there.

If `bun run dev` fails with `Electron uninstall`, the Electron binary was not downloaded: run `node apps/desktop/node_modules/electron/install.js`.

`bun run dev` starts both apps. To run them apart: `bun run --cwd apps/control dev` and `bun run --cwd apps/desktop dev`.

The desktop dev script unsets `ELECTRON_RUN_AS_NODE`. Shells started by T3 Code or other Electron apps set it, and it makes Electron run as plain Node.

## Configuration

| Variable | App | Default |
| --- | --- | --- |
| `CHIEFBOT_CONTROL_PORT` | control | `7410` |
| `CHIEFBOT_CONTROL_HOSTNAME` | control | `127.0.0.1` (`0.0.0.0` in compose and on the GCP control VM; on a Linux host, see `docs/deploy.md`) |
| `CHIEFBOT_DB_PATH` | control | `.data/control.sqlite` (in `apps/control`) |
| `CHIEFBOT_GITHUB_API_URL` | control | `https://api.github.com` |
| `CHIEFBOT_GITHUB_URL` | control | `https://github.com` (the refresh grant) |
| `CHIEFBOT_GITHUB_CLIENT_ID` | control | The sign-in app's client ID in `~/.chiefbot/config.json` (`bun run setup`). Must match the desktop's, or refreshes fail |
| `CHIEFBOT_HOME` | setup, control, desktop | `~/.chiefbot`: setup's config and secrets (control reads the repo app's ID and private key there), and the default secret key. With `gce`, control writes setup's files there from Secret Manager first |
| `CHIEFBOT_SECRET_KEY_FILE` | control | `~/.chiefbot/secret.key`: the key that encrypts refresh tokens, made (mode 600) on first run. Keep it outside the repo. Losing it means signing in again. Not used with `gce` (Secret Manager) |
| `CHIEFBOT_DOCKER_SOCKET` | control | `DOCKER_HOST`'s unix socket, else `~/.colima/default/docker.sock` if it exists, else `/var/run/docker.sock` |
| `CHIEFBOT_COMPUTERS` | control | `docker`; `gce` runs bots as Compute Engine VMs |
| `CHIEFBOT_COMPUTER_IMAGE` | control | `chiefbot-computer:dev` for docker; required for gce |
| `CHIEFBOT_GCP_PROJECT` | control (gce) | required |
| `CHIEFBOT_GCP_ZONE` | control (gce) | `europe-west2-a` (London) |
| `CHIEFBOT_WORKER_CONTROL_URL` | control | `http://host.docker.internal:<port>` (control as a computer reaches it; compose sets the public URL) |
| `CHIEFBOT_IDLE_STOP_MINUTES` | control | `30`: a bot's computer stops after this long with no running turn, no pending approval, no screen viewer and no routine run; a coordinator's with no turn running or queued |
| `CHIEFBOT_APPROVAL_WAIT_MINUTES` | control | `60`: a project's worker waiting this long on one approval fails and its computer stops, keeping its disk. The limit survives a control restart |
| `CHIEFBOT_CONNECTIONS_DIR` | control | The repo's `connections` (`/opt/chiefbot/connections` in the control image): the connections **Connect apps** offers, read at startup |
| `CHIEFBOT_PUBLIC_URL` | control | `http://127.0.0.1:<port>`: control as members' browsers reach it. Connector OAuth sign-ins return to `<it>/connectors/oauth/callback` |
| `CHIEFBOT_CONTROL_URL` | desktop | `http://127.0.0.1:7410` |
| `CHIEFBOT_GITHUB_URL` | desktop | `https://github.com` |
| `CHIEFBOT_GITHUB_CLIENT_ID` | desktop | The sign-in app's client ID in `~/.chiefbot/config.json` (`bun run setup`): device flow, no secret, 8-hour tokens. Whether it is a GitHub App or an OAuth App comes from the config |
| `CHIEFBOT_GITHUB_URL`, `CHIEFBOT_GITHUB_API_URL` | setup | `https://github.com`, `https://api.github.com` |

## Manual check: `bun run setup` on the real GitHub

Tests run setup against a fake GitHub. This check registers two real GitHub Apps on your account and makes no Copilot calls. Time it.

1. On a fresh clone, run `bun install`, then `bun run setup`. A browser tab opens on github.com's **Create GitHub App** page with the name `Chiefbot <6 hex digits>` filled in. If the name is taken, change it.
2. Click **Create GitHub App**. The tab says **Your Chiefbot repo app is registered** and opens the page again for `Chiefbot sign-in <6 hex digits>`. Under **Permissions**, it has none. Click **Create GitHub App**. The tab returns to `127.0.0.1` and says **Chiefbot is set up**. The terminal prints the same two links.
3. `ls -la ~/.chiefbot` shows the folder as `drwx------` and `config.json` and `github-app-secrets.json` as `-rw-------`. `config.json` has `githubApp` and `signIn`. `git status` in the clone shows nothing new.
4. Open the first link (the sign-in app), tick **Enable Device Flow**, click **Save changes**. Open the second link and install the repo app on one repository.
5. Run `bun run setup` again. It refuses: "already set up with the GitHub App … and a sign-in app".
6. Run `bun run computer:build` and `bun run dev`, then do the next check (sign-in). On github.com the device page names the sign-in app. If the window says **Your Chiefbot sign-in app has Device Flow off**, step 4's box is not saved.
7. If sign-in fails with `copilot_internal/user failed`, GitHub refuses that read for the sign-in app's tokens: note the status code, and try the OAuth App fallback (Quickstart).
8. Write down the minutes from step 1 to a signed-in window.

## Manual check: real GitHub sign-in

Tests use a fake GitHub. This check uses the real one and makes no Copilot chat calls.

1. Run `bun run dev`.
2. In the Chiefbot window, click **Sign in with GitHub**. The window shows a code.
3. Click the link, sign in on github.com/login/device, type the code and approve.
4. Within a few seconds the window shows your login and your Copilot plan (for Copilot Free: `individual (free_limited_copilot)`).
5. Quit and start `bun run dev` again. You are still signed in.
6. Open the gear menu at the bottom left of the sidebar and click **Sign out**. The window goes back to **Sign in with GitHub**.

The desktop keeps only control's session token (in the app's user-data folder). GitHub tokens live in `apps/control/.data/control.sqlite`, the refresh token encrypted.

## Manual check: token refresh and Disconnect GitHub

Uses the real GitHub and makes no Copilot calls. Needs Docker, `sqlite3` and `jq`. It never prints a token.

1. Run `bun run computer:build`, then `bun run dev`, and sign in. Create a bot and wait until it is **online**.
2. Read the bot's credential and ask the broker as its worker would:

   ```bash
   BOT=<bot id from docker ps, e.g. bot_…>
   export T=$(docker exec chiefbot-$BOT printenv CHIEFBOT_BOT_TOKEN)
   broker() { curl -s -w ' %{http_code}\n' -H "authorization: Bearer $T" http://127.0.0.1:7410/worker/$BOT/github-token | sed -E 's/"accessToken":"[^"]*"/"accessToken":"…"/'; }
   broker
   ```

   It answers `200` with `expiresAt` about 8 hours after sign-in.
3. Make the stored access token look old: `sqlite3 apps/control/.data/control.sqlite "UPDATE github_access SET access_token_expires_at = 0"`. Run `broker` again. It answers `200` with `expiresAt` about 8 hours from now: control refreshed with GitHub, without a client secret.
4. Click **Disconnect GitHub** in the gear menu at the bottom left of the sidebar. The **Sign in again** notice appears. `broker` answers `{"error":"reauth_needed"} 403`.
5. Click **Sign in again** and finish the device flow. The notice goes away and `broker` answers `200`.
6. Revoke your Chiefbot sign-in app at github.com/settings/apps/authorizations, then repeat step 3. `broker` answers `403` and the notice appears without a reload.
7. Clean up: delete the bot with **Also delete its files**, then `docker rmi chiefbot-computer:dev`.

## Manual check: a bot gets its own computer

Needs Docker running. Makes no Copilot calls.

1. Run `bun run computer:build`, then `bun run dev`, and sign in.
2. Click **New bot** (the pen icon beside **Search**), type a name, pick a face and a colour (or keep the blue chief) and click **Create**. The bot appears in the sidebar and turns green (**online**) within a few seconds.
3. `docker ps` shows `chiefbot-bot_…` running. `docker logs <name>` says `worker connected to http://host.docker.internal:7410 as bot_…`.
4. Click **Stop**. The bot shows **stopped** and the container has exited. Click **Start**. It comes back **online**.
5. Restart control (save a file in `apps/control`). The bot goes back **online** without a click.
6. Click **Delete**, tick **Also delete its files** and confirm. The bot leaves the sidebar, and `docker ps -a`, `docker volume ls` and `docker network ls` show nothing for it. Without the tick, the volume `chiefbot-<bot id>-home` stays: remove it with `docker volume rm`.
7. Clean up: `docker rmi chiefbot-computer:dev`.

## Manual check: watch and take over a bot's screen

Needs Docker running. Makes no Copilot calls.

1. Run `bun run computer:build`, then `bun run dev`, sign in and create a bot.
2. When the bot is **online**, the **Computer** tab of its panel (right of its chat) shows its screen: Chromium on a 1280×800 desktop. The pane says **Watching. The bot drives.** Clicks and keys in the pane do nothing.
3. `docker ps` shows no published port for the bot's container.
4. Click **Take over**. The pane turns green and says **You have control. The bot waits.** Click Chromium's address bar in the pane and type. The text appears. The chat box says **Hand the screen back to message …** and will not send.
5. Click **Hand back**. Typing in the pane does nothing again, and the chat sends.

Take-over lives in control's memory, so restarting control hands the screen back to the agent. A chat turn already running when you take over pauses at its next tool call and goes on after hand-back.

## Manual check: one live Copilot reply

Tests use a fake Copilot. This check makes **one** real Copilot chat on your plan (Copilot Free allows 200 a month) with the plan's default model (Auto on Free).

1. Run `bun run computer:build`, then `bun run dev`. Sign in with the GitHub account that has Copilot.
2. Create a bot (or pick one) and wait until it is **online**.
3. Type `Reply with one short sentence: which directory are you working in?` and press Enter.
4. The chat shows your message, a status line while the bot works, possibly a tool row (for example a shell call), then a reply that streams in and names `/home/bot/workspace`. The status line goes away when the reply is done.
5. Restart control (save a file in `apps/control`) and quit and start the desktop app. The conversation is still there.
6. If the reply is an error instead: "Sign in again" means control lost your GitHub sign-in (click **Sign in again**); a `quota` or `rate_limit` error means the month's Free chats are used up.

## Manual check: a routine wakes a stopped bot

Tests use a fake clock and a fake Copilot, and a fake-Copilot run of this flow passed in the desktop app. This check makes **one** real Copilot chat on your plan.

1. Run `bun run computer:build`, then `bun run dev`. Sign in and create a bot. Once it is **online**, click **Stop**.
2. In the bot's panel, on **Details**, click **+ New routine**. Prompt: `Reply with one short sentence: what time is it where you are?`. Cron: two minutes from now, for example `32 14 * * *` at 14:30. Timezone: yours (filled in). Click **Save**. The row shows the next run time in your local time.
3. Quit the desktop app.
4. Wait a few minutes past the due time. `docker ps -a` shows the bot's container exited again.
5. Start the desktop app and open the bot. The chat shows the prompt and the reply, and its routine under **Details** shows `Last run …: succeeded`.
6. Delete the routine.

## Manual check: the model picker on a real plan

Tests use a fake Copilot. Listing models makes no Copilot chat calls. Step 5 makes **one** chat.

1. Run `bun run computer:build`, then `bun run dev`. Sign in with the GitHub account that has Copilot.
2. Create a bot and wait until it is **online**.
3. Click the model name under the message box (it says **Auto**). The list shows Auto first.
   - On Copilot Free: every other row is greyed with a lock and says "Needs a paid Copilot plan". Clicking one does nothing.
   - On a paid plan: the plan's models are selectable.
4. If no other rows show, the SDK listed nothing. Run `docker logs chiefbot-<bot id>`: a `could not list Copilot models` line says why.
5. On a paid plan only: pick a model, then send `Reply with one short sentence: which model are you?`. The reply should name the picked model's family (Claude, GPT…). Create a second bot and leave it on Auto: the first bot keeps its model.

## Manual check: clone, push and pull request on a disposable repo

Tests use a fake GitHub with a real git remote. This check uses the real GitHub and makes **one** Copilot chat (the agent may take several steps inside it). It creates a repo, a branch and a pull request on your account: delete them at the end.

1. Create a throwaway private repo with a README: `gh repo create chiefbot-scratch --private --add-readme`.
2. Install your repo app on `chiefbot-scratch` (the install link `bun run setup` printed, or github.com/settings/installations). Run `bun run computer:build`, then `bun run dev`, and sign in.
3. Pick a bot (or create one) and wait until it is **online**.
4. Send: `Clone https://github.com/<your login>/chiefbot-scratch, create a branch chiefbot-check, add the line "Hello from Chiefbot" to README.md, commit, push the branch and open a pull request into main with the create_pull_request tool.`
5. The clone and the commit run without a card. Then a **Push approval** card shows `git push to <your login>/chiefbot-scratch: chiefbot-check`, and the status line says **Waiting for your approval**. On github.com the repo has no `chiefbot-check` branch yet.
6. Quit the desktop app and start it again. The card is still there and still pending. Click **Approve**. The push runs, and the branch appears on github.com.
7. A **Pull request approval** card shows `<your login>/chiefbot-scratch: chiefbot-check → main` and the title. Click **Approve**. The bot replies with the pull request's URL. Open it: it has the README change, and GitHub shows it opened by your repo app's bot account (`<app slug>[bot]`).
8. Check that no GitHub token is on the bot's disk or in its git: `docker exec chiefbot-<bot id> sh -c 'grep -rlE "gh[ousr]_" /home/bot /tmp; git -C /home/bot/workspace/chiefbot-scratch remote get-url origin; git config --system --get-regexp credential'` prints only `https://github.com/<your login>/chiefbot-scratch`.
9. Send: `Add a second line to README.md, commit and push.` Click **Decline** on the card. The bot says the push was declined (git shows `[remote rejected] … (The user declined this push.)`), and github.com shows no new commit.
10. Try to push around control, as a hostile agent would, from the bot's computer: `docker exec -w /home/bot/workspace/chiefbot-scratch chiefbot-<bot id> sh -c 'git commit -q --allow-empty -m x; git push https://github.com/<your login>/chiefbot-scratch HEAD:sneaky 2>&1; printf "protocol=https\nhost=github.com\n\n" | GIT_TERMINAL_PROMPT=0 git credential fill 2>&1'`. Both fail: git has no GitHub credential. github.com shows no `sneaky` branch. The bot's own GitHub token cannot push either: the next check. (What still gets through is in `docs/isolation.md`, "What remains".)
11. If a card turns **Expired** while the bot was still running, the Copilot runtime gave up waiting: note how long it waited. If git says `lost your GitHub sign-in`, control needs a new sign-in: click **Sign in again**. If git says `Install your Chiefbot repo app on …`, the repo app is not installed on the repo.
12. Clean up: `gh repo delete <your login>/chiefbot-scratch --yes` (it removes the pull request too).

## Manual check: the sign-in token cannot write, and drives Copilot

Tests use a fake GitHub that, like GitHub, limits a user token to its app's permissions, and a fake Copilot. This check uses the real GitHub and makes **one** Copilot chat on your plan. It settles whether a GitHub App with no permissions can run Copilot. It never prints a token. Needs Docker, `jq` and the `chiefbot-scratch` repo from the previous check (steps 1 and 2).

1. Run `bun run computer:build`, then `bun run dev`, and sign in. Create a bot and wait until it is **online**.
2. Take the token the bot's computer gets, as a hostile agent in it could:

   ```bash
   BOT=<bot id from docker ps, e.g. bot_…>
   T=$(docker exec chiefbot-$BOT printenv CHIEFBOT_BOT_TOKEN)
   GT=$(curl -s -H "authorization: Bearer $T" http://127.0.0.1:7410/worker/$BOT/github-token | jq -r .accessToken)
   echo "${GT:0:4}"   # ghu_ for the sign-in GitHub App, gho_ for the OAuth App fallback
   ```

3. It knows who you are: `curl -s -H "authorization: Bearer $GT" https://api.github.com/user | jq -r .login` prints your login.
4. It cannot read the private repo: `git ls-remote https://x-access-token:$GT@github.com/<your login>/chiefbot-scratch` fails with `Repository not found` (or 403).
5. It cannot push: `D=$(mktemp -d) && git -C $D init -q && git -C $D -c user.name=x -c user.email=x@example.com commit -q --allow-empty -m x && git -C $D push https://x-access-token:$GT@github.com/<your login>/chiefbot-scratch HEAD:stolen; rm -rf $D` fails, and github.com shows no `stolen` branch.
6. It cannot open a pull request: `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "authorization: Bearer $GT" https://api.github.com/repos/<your login>/chiefbot-scratch/pulls -d '{"head":"main","base":"main","title":"stolen"}'` prints `404` or `403`, never `201` or `422`.
7. `unset T GT`.
8. It drives Copilot: send the bot `Reply with one short sentence: which directory are you working in?`. The reply names `/home/bot/workspace`.
9. If step 8 ends in an error about authorization or Copilot access instead (not a `quota` or `rate_limit` one), the sign-in GitHub App's token cannot run Copilot. Note the error, switch to the OAuth App fallback (Quickstart), sign in again and repeat steps 2 to 8: step 2 then prints `gho_`.
10. Record which sign-in app passed step 8, and the error if one failed, in the ticket.

## Manual check: two members ask a project's coordinator for the same thing

Tests use a fake Copilot. This check makes 3 live Copilot calls on the real GitHub with two accounts in one workspace (as in the workspace check below). It needs Docker and the computer image rebuilt with this code (`bun run computer:build`).

1. In a repo your repo app is installed on, commit a `chiefbot.project.yaml` at the root with `commands: { test: bun test }`. In a second repo, commit one with a typo: `conectors: [github]`.
2. Run control and the desktop apart (`bun run --cwd apps/control dev`, `bun run --cwd apps/desktop dev`) and sign in as the workspace owner. Pick the workspace in the switcher.
3. Click **New project** (the folder icon beside **Search**) and type the second repo as `owner/repo`. The form shows `invalid_project_file` with `Unrecognized key: "conectors"`, and no project appears.
4. Create a project from the first repo. It opens with its build and test commands under its name, an empty chat and **Tasks: 0 open**.
5. Send: "We need a dark mode toggle in settings. Track it as a task." The reply comes back and the task appears under **Tasks** as #1, asked by you.
6. Start a second desktop as the member (`bun run --cwd apps/desktop dev -- --user-data-dir=/tmp/chiefbot-second`), open the project and send: "Can we get dark mode in the settings page?" The coordinator answers that task #1 already covers it. The ledger still shows one task in both desktops.
7. In the second desktop send: "Mark the dark mode task as in progress." Both desktops show #1 **In progress** without a reload.
8. In the second desktop the project has no **Delete** button: only the owner deletes. In the first desktop click **Delete** and confirm. The project leaves the sidebar and `docker ps -a` no longer lists `chiefbot-project_…`. Clean up: `rm -rf /tmp/chiefbot-second`.

## Manual check: connectors, the checklist and the call log

Tests use a fake MCP server and a fake Copilot. This check uses the real GitHub MCP server and Atlassian's, and makes 5 live Copilot calls. It needs Docker, the computer image rebuilt with this code (`bun run computer:build`), a project as in the check above, and a Jira site you can sign in to.

1. Commit `connectors: [github, jira]` to the project repo's `chiefbot.project.yaml` and create the project again (control reads the file when the project is made).
2. Open **Connectors** in the sidebar. The checklist lists **github** and **jira** as **Not defined**. Click **Add preset** on each. Both now say **Connect your own account**, needed by the project.
3. Click **Connect** on GitHub. A token field opens (GitHub's MCP server has no sign-in control can run). Paste a fine-grained personal access token with read access to the repo and click **Save**. GitHub shows **Ready**.
4. Click **Connect** on Jira. The browser opens Atlassian's consent page. Approve. The browser shows "Connected to Jira", and within a few seconds the checklist shows **Ready**. If Atlassian refuses the `http://127.0.0.1` callback, note its error: set `CHIEFBOT_PUBLIC_URL` to an https URL that reaches control and retry.
5. In the project's chat send: "List the open issues of this repo on GitHub and my assigned Jira issues." The reply uses both.
6. Send: "Create a Jira issue in <project key> titled Chiefbot approval check." A **Connector approval** card naming Jira and the tool appears in your chat, and Jira has no such issue yet. Click **Approve**: the issue appears. Send the same again and click **Decline**: no second issue, and the coordinator says it was declined.
7. Send: "Comment 'hello' on the newest issue of this repo using your GitHub tools." The coordinator finds no GitHub tool that writes (the preset is GitHub's read-only server) and says so. Nothing is posted.
8. Click **Connector calls** in the project's header. It lists the GitHub and Jira calls, asked by you, as you, with the turn's id. The declined call is not there.
9. Check that your GitHub token never reached the coordinator's computer: `docker exec chiefbot-<project id> sh -c 'env | grep -c github_pat_; grep -rl github_pat_ /home/bot 2>/dev/null'` prints `0` and no file.
10. In a second desktop signed in as a member (as in the check above), open **Connectors**: GitHub and Jira say **Connect your own account**, since your connections are yours alone.
11. Clean up: delete both connectors as the owner (their tokens go too), delete the Jira issue, and revoke the GitHub token on github.com.

## Manual check: a bot uses Jira through a connection

Tests use a fake CLI and a fake Copilot. This check uses a real Jira site and makes 2 to 3 live Copilot calls. It needs Docker, the computer image rebuilt with this code (`bun run computer:build`), a bot made after the rebuild, and a Jira project you may write to.

1. Open the gear menu, click **Connect apps**, then **Connect** on Jira. Fill in your site, email and an API token with scopes, and click **Save**. Jira shows **On**.
2. Send the bot: "List my open Jira issues." It signs in with `acli` and lists them, with no approval card.
3. Send: "Create a Jira issue in <project key> titled Chiefbot connection check." A **Connector approval** card shows `Jira: acli jira workitem create …`, and Jira has no such issue yet. Click **Approve**: the issue appears.
4. Once the turn ends, check nothing of it is left: `docker exec chiefbot-<bot id> ls /tmp/chiefbot` says no such file, and `docker exec chiefbot-<bot id> grep -rl <first 12 characters of the token> /home/bot` prints nothing.
5. Open the bot's **Details** tab. **Connection calls** lists `acli jira auth login`, `acli jira workitem search` and `acli jira workitem create`.
6. Click **Disconnect** on Jira and send "List my open Jira issues" again. The bot has no Jira skill and `acli` is not signed in.
7. Clean up: delete the issue in Jira.

## Manual check: a chief of staff hands work to a project

Tests use a fake Copilot. This check makes 5 live Copilot calls on the real GitHub with one account. It needs Docker and the computer image rebuilt with this code (`bun run computer:build`).

1. Set up a workspace and a project from a repo with a valid `chiefbot.project.yaml`, as in the check above (steps 1, 2 and 4). Create a bot and wait until it is **online**.
2. In the bot's chat send: "Hand the <project name> project this: add a dark mode toggle to the settings page. It is done when a pull request adds the toggle." The chat shows `send_to_project` succeeding (it may call `list_projects` first) and a reply naming the task number, say #1.
3. Open the project. Your chat with the coordinator shows a message from your chief of staff about task #1 with "Done when: …", and the coordinator's reply. **Tasks** shows #1, asked by you.
4. In the project chat send: "Set task #1 to needs input: ask me which settings page." Back in the bot's chat a notice says the project needs your input on task #1. It appears even if the bot was mid-reply or stopped.
5. In the project chat send: "Mark task #1 done." The bot's chat shows a second notice: the project finished task #1.
6. In the bot's chat send: "How is the dark mode handoff going?" The chat shows `handoff_status` and a reply saying it is done.
7. Restart control and the desktop. Both notices are still in the bot's chat. Clean up: delete the project and the bot.
## Manual check: a project's task ends in a pull request from a worker

Tests use a fake Copilot, fake computers and a fake GitHub. This check uses the real GitHub and Docker and makes 2 to 4 live Copilot calls (one coordinator turn, one worker turn, maybe a follow-up question). It creates a repo, a branch and a pull request on your account: delete them at the end.

1. Create a disposable repo with a README and a project file: `gh repo create chiefbot-worker-check --private --add-readme`, then add `chiefbot.project.yaml` with `commands: { test: "true" }` on `main` (for example in the github.com editor). Install your repo app on it.
2. Run `bun run computer:build` (this code must be in the image), then control and the desktop apart (`bun run --cwd apps/control dev`, `bun run --cwd apps/desktop dev`). Sign in, pick a workspace and create a project from the repo.
3. Send the coordinator: `Create a task "Say hello in the README": add the line "Hello from a Chiefbot worker" to README.md. Then dispatch a worker on it.` The task appears under **Tasks**, and under it **Worker: starting its computer**, then **Worker: working · On <your login>'s Copilot seat**. `docker ps` shows a new `chiefbot-worker_…` container next to `chiefbot-project_…`.
4. A **Push approval** card appears under the task with `git push to <your login>/chiefbot-worker-check: <branch>`. On github.com the branch does not exist yet. Click **Approve**. The branch appears.
5. A **Pull request approval** card appears with the branch, `main` and the title. Click **Approve**. The task gets a **pull request** link under the worker, which shows **Worker: finished**. Open the link: the pull request has the README change, opened by your repo app's bot account. `docker ps -a` shows the worker's container **Exited**: its computer stopped when its turn ended, and keeps its volume.
6. Ask the coordinator: `What is the status of the worker? Show me its transcript.` It answers from `worker_status` and `worker_transcript`: finished, the pull request, the worker's summary.
7. Restart control (save a file in `apps/control`). The worker's container stays, stopped: the task is not done yet.
8. Send: `The pull request is accepted: mark the task done.` Within a few seconds `docker ps -a` no longer lists the `chiefbot-worker_…` container, and `docker volume ls` and `docker network ls` show nothing for it.
9. Leaked computers: create a second task and dispatch a worker on it. While it shows **working**, stop control (Ctrl-C). Mark the worker's computer as a failed delete would leave it: `sqlite3 apps/control/.data/control.sqlite "UPDATE task_workers SET computer = 'unwanted' WHERE state = 'working'"`. Start control again. Within a few seconds its container, volume and network are gone.
10. Approval wait limit: stop control and start it again with `CHIEFBOT_APPROVAL_WAIT_MINUTES=3`. Create a third task, dispatch a worker on it and leave its **Push approval** card unanswered. After a minute restart control once more (the limit must survive it). About three minutes after the card appeared the worker shows **failed**, its result saying it waited too long, and `docker ps -a` shows its container **Exited** with its volume kept.
11. If a card never appears and the worker shows **failed**, its result says why (a lost GitHub sign-in, the repo app not installed on the repo). `docker logs chiefbot-worker_<id>` shows the worker's side.
12. Clean up: delete the project (owner only), then `gh repo delete <your login>/chiefbot-worker-check --yes`.

## Manual check: a project listens to CI and an issue query

Tests use a fake MCP server, a fake clock and a fake Copilot. This check polls the real GitHub MCP server and makes about 3 live Copilot calls (one per event). It needs Docker, the computer image rebuilt with this code (`bun run computer:build`), and a repo with a GitHub Actions workflow you can make fail.

1. Commit `connectors: [github, github-actions]` to the repo's `chiefbot.project.yaml`, create the project, add both presets on **Connectors** and connect a fine-grained personal access token with read access to the repo's actions, issues and metadata to each.
2. Open the project and click **Listening to**. Add **CI failures on a branch**: connector `github-actions`, branch `main`, every 1 min. Add **An issue query**: connector `github`, query `repo:<owner>/<repo> is:issue is:open label:chiefbot-test`, every 1 min. Add **A schedule**: "Post a one-line status note", cron two minutes from now, your timezone.
3. Within a minute both polls show "checked …" and "as <your login>", with no error. No task appears: the first poll only notes what is there.
4. Push a commit that makes the workflow fail on `main`. Within a minute of the run finishing, **Tasks** shows "CI failed on main: …" linking the run, and your chat shows the subscription's message about that task and the coordinator's reply.
5. Open an issue with the label `chiefbot-test`. Within a minute a task "Issue #…" appears with one message. Edit the issue's title: one more task appears. Nothing else repeats.
6. At the schedule's due time, a task "Scheduled: Post a one-line status note" and its message appear.
7. Restart control. After two more minutes the ledger has no duplicates. **Connector calls** lists `actions_list` and `search_issues` calls, as you, with the subscription's id as the run.
8. Clean up: remove the three subscriptions, delete the project, the issue and the failing commit, and revoke the token.

## Manual check: an organization pays for a project's coordinator

Needs a GitHub organization with Copilot Business or Enterprise whose policy allows Copilot requests from GitHub App installations, and an organization-owned repo with a `chiefbot.project.yaml` (an empty file is fine). Uses about two Copilot requests.

1. On a fresh `~/.chiefbot` (or a copy in `CHIEFBOT_HOME`), run `bun run setup --org <organization> --org-billed-copilot`. On github.com the repo app's page lists **Copilot Requests: Read and write** next to contents and pull requests. Install it on the organization with **All repositories**, as the printed step says, and tick Device Flow on the sign-in app.
2. Run `bun run computer:build`, then `bun run dev`, and sign in. Create a workspace and a project for the repo. Send the coordinator `Reply with one short sentence: who are you?`. The chat shows `On <your login>'s Copilot seat` above the reply.
3. On the **Members** screen, set **Copilot for projects** to **The organization**. Send the coordinator another message. The chat shows `Billed to <organization>'s Copilot (organization)` and a reply: the token worked. Note any error: `401` means the organization is not enabled for Copilot requests from GitHub App installations; `403` means the install is not on All repositories, or the token request lacks `repository_ids`.
4. Check the token cannot touch the repo. Find the coordinator's runtime: `docker exec chiefbot-<project id> sh -c 'for p in /proc/[0-9]*; do tr "\0" "\n" < $p/environ 2>/dev/null | grep ^COPILOT_GITHUB_TOKEN=; done | sort -u'`. With that token, `curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <token>" https://api.github.com/repos/<organization>/<repo>/contents/chiefbot.project.yaml` prints `404` (or `403`), never `200`.
5. On github.com, the organization's Copilot usage (Settings → Copilot → usage or the billing report) lists the requests under the app's installation within a day, not under your seat.
6. Renewal (optional, about an hour): leave the project idle for 45 minutes, then send another message. It is answered, and `docker exec chiefbot-<project id> ps -o pid,lstart,args | grep -i copilot` shows a runtime started just now. The earlier messages are still in the conversation: ask `What did I ask you first?`.
7. Mid-task renewal (optional, over an hour, a few Copilot requests): send the coordinator `Create a task "Long wait" and dispatch a worker on it with these instructions: run "sleep 3600; echo finished" in the shell, then reply with its output.` About 55 minutes after the worker starts, `docker exec chiefbot-worker_<id> ps -o lstart,args | grep -i copilot` shows a runtime started just now, and **worker_transcript** shows the worker going on. It ends **finished**, not failed.
8. Clean up: delete the project and the workspace, and uninstall the repo app from the organization if it was only for this check.

## Manual check: production with docker compose

Checked locally on Colima with a fake GitHub (no Copilot calls): control in its container made a bot container through the Docker socket, the bot came online, a `wss://` socket and the connector OAuth callback worked through Caddy (its local certificate for `localhost`), and stop and delete removed the container and its volume. This check needs a Linux machine with a DNS name, and makes 2 to 3 live Copilot calls.

1. Follow `docs/deploy.md`, "Docker compose on one Linux machine", steps 1 to 4.
2. Run its smoke check, steps 1 to 7.
3. `docker compose down -v` and remove the DNS record when done.

## Manual check: invite a second GitHub account to a workspace

Tests use a fake GitHub with two users. This check uses the real GitHub with two accounts (the second can be a throwaway account) and makes no Copilot calls. It needs no Docker.

1. Run control and the desktop apart: `bun run --cwd apps/control dev` in one terminal, `bun run --cwd apps/desktop dev` in another. Sign in as your first account.
2. Open the switcher at the top of the sidebar (it says **Personal**), type a name in **+ New workspace** and press Enter. The workspace becomes current and its **Members** screen lists you as **owner**.
3. Type the second account's login, in any letter case, and click **Invite**. It shows as invited, "joins once they sign in and accept".
4. Quit the desktop (control keeps running). Start one with its own sign-in: `bun run --cwd apps/desktop dev -- --user-data-dir=/tmp/chiefbot-second`, and sign in as the second account.
5. In this second desktop, the switcher shows a **1** badge. Open it and click **Accept**. The workspace becomes current, with you as **member** and a **Leave** button.
6. Click **Leave**. It goes back to **Personal**. Quit it and start the first desktop again (`bun run --cwd apps/desktop dev`): its **Members** screen lists only the owner.
7. Invite the second account again, accept as in steps 4 and 5, then click **Remove** next to it in the first desktop. In the second desktop, the workspace is gone from the switcher.
8. Removal ends what runs (optional; needs Docker, a project in the workspace as in the worker check, and 2 Copilot calls): invite and accept once more. As the second account, ask the project's coordinator to create a task and dispatch a worker on it, and keep the project's chat open. While the worker shows **working**, remove the account in the first desktop. The second desktop's project chat closes, and within seconds `docker ps -a` no longer lists the worker's container.
9. Clean up: `rm -rf /tmp/chiefbot-second`.
