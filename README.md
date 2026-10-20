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

**Org-billed Copilot.** A workspace's project agents (coordinators, engineers and verifiers) can run on an organization's Copilot instead of each member's seat (GitHub's [server-to-server tokens](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens)). Run `bun run setup --org <organization> --org-billed-copilot`: the repo app also asks for **Copilot Requests** (write). Install it on the organization with **All repositories**, which GitHub's Copilot check needs, and turn on the organization's policy that allows Copilot requests from GitHub App installations. Already set up? Add **Copilot Requests: Read and write** to the repo app's permissions on github.com and accept the change on the installation. Then a workspace owner picks **The organization** under **Copilot for projects** on the **Members** screen. Chiefs always run on their owner's seat.

**Fallback: an OAuth App to sign in.** If the sign-in app's tokens cannot run Copilot (manual check "the sign-in token cannot write, and drives Copilot"), sign in with an OAuth App instead, which asks only for `read:user`:

1. Open github.com/settings/applications/new (for an organization: its **Settings → Developer settings → OAuth Apps → New OAuth App**).
2. Fill in any name, `https://github.com/JorgeMenaDev/chiefbot` as the homepage URL and `http://127.0.0.1/` as the callback URL (the device flow does not use it).
3. Tick **Enable Device Flow** and click **Register application**. Copy the **Client ID**. No client secret is needed.
4. Run `bun run setup --oauth-client-id <client ID>`. It keeps your repo app (or registers it first) and records the OAuth App as the sign-in app. Sign in again in the desktop: it asks GitHub for `read:user` and `offline_access`, so tokens expire after 8 hours and refresh like the sign-in app's.

In the desktop app, click **Sign in with GitHub**. Your first sign-in brings a bot named **Chief of Staff**, once: delete it and it stays deleted. **New bot** (the pen icon beside **Search bots** in the sidebar) adds more, each with the face and colour you pick. The sidebar has two tabs, **Bots** and **Projects** (Cmd+1 and Cmd+2, Ctrl off macOS). Each keeps what you selected in it and your drafts. The sidebar hides with the button beside the window buttons, or Cmd+B. The gear at its bottom left opens a menu with your GitHub login, your Copilot plan, **Connect apps**, **Settings**, **Disconnect GitHub** and **Sign out**. The heartbeat icon beside it opens **Health**. **Settings** sets the color scheme, as T3 Code does: **System** (follows the OS), **Light** or **Dark**, the default.

Timing, measured on a fresh clone on an Apple-silicon Mac: `bun install` with an empty Bun cache took 5 s and `bun run computer:build` 69 s with the `oven/bun` base image already pulled (allow about 2 minutes without it). Setup is about a minute of clicking on github.com.

Other commands: `bun run check` (typecheck, tests and the public-repo check; no network, Docker or GCP). `CHIEFBOT_COMPUTER_IMAGE` names another image tag.

## How it works

Creating a bot needs Docker and the `chiefbot-computer:dev` image. Each bot is a container `chiefbot-<bot id>` on its own network `chiefbot-<bot id>-net`, with a volume `chiefbot-<bot id>-home` mounted at `/home/bot` (its home and workspace). Its worker dials control's `/worker/<bot id>` WebSocket with a per-bot credential and the bot shows **online**. Bots cannot see each other: `docs/isolation.md`.

`CHIEFBOT_DOCKER_TESTS=1 bun test docker.live` runs the whole loop on real Docker (needs the image). `CHIEFBOT_DOCKER_TESTS=1 bun test isolation.live` shows two bots cannot read each other's volume or reach each other over the network. Both use `CHIEFBOT_COMPUTER_IMAGE` if set and remove what they create.

**Chat.** A message to a bot goes to control, which stores it and forwards it to the bot's worker. The worker runs the turn on the Copilot SDK (`@github/copilot-sdk`, pinned exactly in `apps/worker/package.json`) in `copilot-cli` mode, working in `/home/bot/workspace`. The bot has one conversation; the SDK keeps it under `/home/bot/.copilot`, so it resumes after the computer restarts. The SDK gets the user's GitHub access token from control's broker (`GET /worker/<bot id>/github-token`) through `gitHubTokenProvider`. Reply text, tool calls and status stream back to the desktop and are stored in control, so history survives a restart of any process. The image carries the SDK's bundled Linux runtime (about 170 MB of the image).

**Computer use.** A bot, and a project's task worker, sees and operates its own computer's screen with one tool, `computer` (`apps/worker/src/computerUse.ts`), and its session's instructions say the screen is there. The screen is a desktop whose dock, at the bottom, opens Chromium, Files (Thunar) and Terminal (xfce4-terminal), the last two in `/home/bot/workspace`. Nothing opens at boot: to browse, the bot opens Chromium from the dock. A call takes 1 to 10 actions: click, move, drag, scroll, type (up to 1000 printable characters, newlines and tabs), key (one key or chord of X key names, such as `ctrl+l` or `Return`), wait (up to 5 seconds) and screenshot. A key that names an xdotool command is refused, so a key cannot run one. The worker runs the actions in order with xdotool and stops at the first that fails. Each command is killed after 10 seconds or 1 MB of output. Every call then waits 300 ms and gives the model one PNG screenshot (scrot), where the pointer is and how many actions ran. Coordinates are screenshot pixels: the screen is 1280×800, so nothing is scaled. The screenshot goes only to the model: scrot writes it in the turn's temporary folder (`/tmp/chiefbot/screen`), and the worker reads it and deletes it at once. Control never gets it. The chat shows each call as a tool row that names its actions (`computer: key, type, key, wait`). **Supervised** and **Auto-accept edits** ask before each call, and the card lists its actions; **Auto** and **Full access** run it. When you take over the screen, a call already running stops before its next action (or between 100-character chunks of its text), and the next call waits for hand-back. A call whose turn ends, or that the runtime cancels, stops its running command, releases any mouse button or keys that command held down, and runs no other. Chromium keeps the logins made on the bot's computer. A model that cannot see images gets only the text. A bot made before this keeps a computer without the tool until you update it (docs/deploy.md).

**Tokens.** The desktop signs in with your sign-in app's device flow. That app has no repository permissions, so its tokens (`ghu_…`, or `gho_…` from an OAuth App) can read who you are and your Copilot plan, and cannot write to any repo. The broker hands a bot only its owner's access token, for the Copilot SDK, with more than two hours left, never the refresh token. When less is left it refreshes with GitHub's refresh grant (device-flow tokens need no client secret), one refresh at a time per user: a refresh invalidates the old pair, so concurrent requests share it. The refresh token sits in a `SecretStore`: locally encrypted (AES-256-GCM) in control's SQLite under the key in `CHIEFBOT_SECRET_KEY_FILE`; on GCP in Secret Manager. When GitHub refuses the refresh token (expired after 6 months unused, or the app's authorization was revoked on github.com), or the user clicks **Disconnect GitHub**, control forgets the sign-in: bots get a typed `reauth_needed` refusal, their turns end with "Sign in again", and the desktop shows a **Sign in again** notice. Disconnect does not revoke the app at GitHub: an access token already handed out works until it expires, at most 8 hours, unless you revoke the sign-in app's authorization at github.com/settings/apps/authorizations.

**Model per bot.** Each bot has its own Copilot model, chosen in the composer's model picker. Once a bot's worker connects, it lists the models the owner's Copilot plan offers on the bot's SDK session and reports them to control. Control keeps the latest list per user in SQLite (`GET /models`). Picking a model saves it on the bot (`PUT /bots/:id/model`). A model that takes a reasoning effort shows an effort picker beside it, offering only the levels the SDK lists for that model, its default marked; switching models keeps the effort where the new model supports it. Every turn carries the bot's model and effort, and the worker sets both on the session before the turn (the SDK changes them on an open session), so the conversation is kept. On Copilot Free only Auto can be picked: the SDK accepts a switch but every turn still runs on Auto, so the other models in Copilot's catalog show as locked rows with "Needs a paid Copilot plan". On a paid plan, models a Copilot policy turns off show locked too.

**Routines.** A routine is a prompt plus a schedule: a cron expression (5 fields, or 6 with seconds) read in an IANA timezone, parsed by `croner`. The **Details** tab of a bot's panel (right of its chat) lists them, to add, edit or delete. Control runs them whether or not the desktop is open: at the due time it starts the bot's computer if it is stopped, waits up to 5 minutes for the worker, sends the prompt as a chat turn (30 minutes at most) and stops the computer again if the run started it. The reply lands in the bot's chat, and the routine shows its last run: succeeded, failed (with the reason, such as a lost GitHub sign-in) or skipped (the bot was busy, or someone had taken over its screen; no retry). A bot runs one routine at a time. Each (routine, due time) runs at most once, even across control restarts: a run cut short by a restart is marked failed and its computer stopped again, and due times missed while control was down run once when it is back.

**Connections.** **Connect apps** in the gear menu turns on command-line tools for your own bots, signed in as you: Jira (Atlassian's `acli`), Harness (the `harness` CLI) and Dynatrace (`dtctl`). Each is a folder under `connections/`: a definition, a skill for the agent and an install step for the computer image. Your fields go to control (secret ones to its `SecretStore`); only during a turn of one of your bots does its worker write them to `/tmp/chiefbot` with the skill and a wrapper for the CLI, and it deletes them when the turn ends. A command of the CLI that may write waits for your approval, and each run of the CLI shows under **Connection calls** in the bot's **Details** tab. The approval is a guardrail, not a boundary: use scoped tokens that expire. **Health** (the heartbeat icon beside the gear) checks Google Cloud, Dynatrace and Looker every 5 minutes with read-only API calls, without asking a bot. See `docs/connections.md`.

**Services.** **Health** also checks health URLs you run yourself, such as a web app or an API, in each environment it runs in: prod, preprod, int or any other name, up to 6 per service. **Add service** on its **Services** card takes a name, an icon and, per environment, a URL and its authentication: none, a bearer token, or a header and its value. The token or value goes to control's `SecretStore`, one per environment, and never comes back to the desktop: **Edit** shows it as **Saved**, and asks for it again when the URL's origin or the kind of authentication changes. **Test** checks an environment before you save it. Control fetches each URL when you open **Health** and when you click **Refresh**, never on the 5-minute timer, and runs at most 4 at once per user. A 2xx answer within 2 seconds is healthy and a slower one is slow. Anything else is down: another status, no answer within 10 seconds, no connection, or a JSON `status` of `DOWN` or `OUT_OF_SERVICE` (as Spring Boot Actuator reports) even with a 2xx. Control reads at most 64 KB of an answer, follows no redirect (a secret never reaches another host), and refuses cloud metadata addresses, checked on the address the name resolves to. A service's status is the worst of its environments, an unhealthy environment has **Ask my bot**, and control keeps each environment's checks for 24 hours. `bun run mock:services` serves three services to try it on: "Manual check: your own services on Health".

**Access modes.** The composer's access picker, after T3 Code's, sets how freely each bot acts in its computer before asking (`PUT /bots/:id/access`, sent with every turn, mapped onto permission requests in `apps/worker/src/approvals.ts`). **Supervised** asks before everything that changes something: every shell command, file change and connection call, and every tool, memory, hook, workflow or extension request that is not only reading (`send_to_project` and `computer` too). Reads of files, URLs and read-only tools run. **Auto-accept edits** asks for the same but changes files without asking, and runs commands the Copilot runtime sees only reading. **Auto**, the default, asks only before a connection command that may write and a GitHub tool that writes. **Full access** asks before nothing in the computer, as Copilot's "allow all". In every mode control still asks before each push and pull request, the agent waits while you have its screen, and nothing is granted once its turn ends. Projects' coordinators, engineers and verifiers keep Auto's rules. A bot's computer made before access modes and files runs only Auto turns without files: control refuses any other until you update its computer (docs/deploy.md).

**Files in a message.** In a bot's composer, paste, drop or attach (the paperclip) up to 5 files of up to 10 MB each, as in T3 Code. Images show as thumbnails above the prompt and documents as rows, each with a remove button. A document's chip, `[name]`, goes where the cursor is, and so does an image's when the prompt already has text. A file takes its place at once and is read after; the message waits until every file is read, and the composer takes no edits or files while it is being sent. The desktop sends the files with the message; control refuses a body larger than 5 files of 10 MB make (413) and reads at most 4 messages with files at once (503 while busy). The chat reads a sent image when it scrolls into view and keeps only the last few. Control keeps them in SQLite with their turn (deleted with the bot), so the chat shows them again later (`GET /bots/:id/attachments/:attachmentId`). The bot's worker reads them with the turn's key, saves them in `/home/bot/workspace/attachments/<turn id>/` and gives each to the SDK's `send` as a file attachment, which the runtime reads from disk. When the SDK says the bot's model cannot see images, the composer says so under the prompt. Projects' chats take no files.

**Idle stop.** Control stops a bot's computer after 30 minutes (`CHIEFBOT_IDLE_STOP_MINUTES`) with no running turn, no pending approval, no screen viewer and no routine run in progress, with Docker and on GCP alike. **Start** in the app or a due routine starts it again. A project's coordinator computer stops the same way after 30 minutes with no turn running or queued, and the next message for it (from a member, a handoff or a subscription) starts it again.

**Repo work and approvals.** A bot clones, branches, edits and commits in its workspace without asking. Before it pushes or opens a pull request, you approve it: the chat shows an approval card (after T3 Code's) with the repo and branches or the pull request, and the bot waits until you click **Approve** or **Decline**, however long that takes. Control holds repo access, so the approval is checked outside the bot's computer (`apps/control/src/repos.ts`). Git in the bot computer reaches github.com only through control's git proxy (`/git/<owner>/<repo>.git`): the worker points the agent's git there (`apps/worker/src/gitProxy.ts`) and its credential helper hands git the running turn's key (control issues one per turn and revokes it when the turn ends: `docs/isolation.md`), never a GitHub token. Control checks, through your repo app, that your GitHub account may read the repo (or push to it), lets fetches through, and holds each push until you approve it; then it forwards exactly that push with a one-hour installation token of your repo app, scoped to that one repo. The bot's `create_pull_request` tool asks control, which opens the pull request with the same kind of token after you approve. Neither token ever reaches the bot. A repo your repo app is not installed on can be cloned only if it is public, and never pushed to. Control stores each request and answer (`POST /bots/<id>/approvals/<approval id>`), so a pending card survives a restart of the desktop and you can answer later. If control restarts while a push waits, git fails and the bot can push again (a new card); the old card stays until the turn ends and does nothing. If the bot's computer restarts first, the turn ends and the card shows **Expired**. A routine's turn waits for approvals the same way: if its 30-minute limit passes first, the run is marked failed, but the card stays answerable and the bot's computer stays running until the turn ends. Inside the computer, the worker still asks before a GitHub tool that writes (`apps/worker/src/approvals.ts`). What approvals do and do not stop: `docs/isolation.md`.

**Questions.** A bot can ask you something in a card instead of in plain text. Each bot turn turns on Copilot's built-in `ask_user` tool as forms (`askUserVariant: "elicitation"`, `apps/worker/src/copilotSdk.ts`), and each form shows in the chat as a **Question** card, after T3 Code's: one question at a time with a step counter, options to pick one or several (keys 1–9 pick one, in the card you are in or else the newest), **Other** for an answer of your own, an optional **Comment** that keeps your pick, **Submit answers** on the last step and **Don't answer**. A yes/no question shows **Yes** and **No**, and a number or yes/no answer reaches the agent as a number or boolean unless you type an answer of your own. Control stores each question and answer apart from approvals (`POST /bots/<id>/questions/<question id>`), so a card survives a restart of the desktop or of control and you can answer later, and a draft survives a reload of the window. A question is withdrawn when its turn ends, when you **Stop** the bot or when Copilot ends the request itself. If the bot's computer restarts first, the card shows **Expired**. Questions do not depend on the access mode. Projects' coordinators, engineers and verifiers do not ask yet.

**Workspaces.** A workspace is a team. Anyone signed in can create one and is its owner. The owner invites people by GitHub login; an invite waits until someone with that login signs in to Chiefbot and accepts it from the workspace switcher at the top of the sidebar's **Projects** tab. The **Members** screen lists members and pending invites: the owner invites, withdraws invites and removes members, and a member can leave. There are two roles, owner and member, and the owner cannot leave. Removing a member, or leaving, ends at once what runs for them in the workspace's projects: their project chats close, their queued messages to coordinators go, their running coordinator turn ends, the engineers and verifiers they asked for stop, and control refuses every token, connector and worker request made for them. Every workspace route answers 404 to anyone who is not a member, so outsiders cannot tell a workspace exists. Projects and connectors belong to a workspace; bots stay personal.

**Projects.** A project binds one GitHub repo to a workspace. Any member creates one in the **Projects** tab: **New project** (the folder icon beside **Search projects**, or the form a workspace with no projects shows), then `owner/repo` and **Create**, with no commit to the repo. Control checks through your repo app that the member may read the repo, so the repo app must be installed on it (a public repo also works without it), and reads the repo's `chiefbot.project.yaml` from its default branch if there is one. A repo the member's GitHub account cannot see is refused (`repo_not_found`). The file is optional. It is checked with a Zod schema (`ProjectFile` in `packages/contracts/src/projects.ts`): every key is optional, and unknown keys are errors.

```yaml
instructions: [docs/agents.md]   # files the agents read besides AGENTS.md
commands:
  setup: bun install             # runs in each engineer's and verifier's clone first
  build: bun run build
  test: bun test
  dev: bun run dev               # starts the app
  devUrl: http://localhost:3000  # where the app then answers
skills: [.agents/skills]         # folders of skills the agents load
verify: verify-app               # the skill a verifier follows
connectors: [github, jira]       # the connectors (MCP servers) its agents need, by name
mcp:                             # stdio MCP servers that run in engineers and verifiers only
  playwright: { command: npx, args: ["-y", "@playwright/mcp"] }
secrets: [API_KEY]               # names only: members set the values in the app
workers: { max: 2 }              # engineers and verifiers at once (default 2); more are queued
```

Each project also has **settings** in the app: the same keys, as YAML. They are how you configure a repo you cannot commit to. The gear in the project's header opens them in place of the conversation, and any member edits them (`PUT /projects/:id/settings`). The project's config takes each key from the settings when they set it, else from the file, else its default. `commands` and `workers` merge key by key, so a file's `test` and the settings' `setup` both apply. Any other key replaces the file's: `connectors: []` in the settings clears the file's list. **Settings** lists every key with its value and where it comes from: file, settings or default. With no file, the project's header shows a **No project file** badge and **Settings** says "No project file, using app settings". With an invalid file, the badge says **Invalid project file**, and **Settings** shows the file's error and uses the settings alone. A file over 64 KB counts as invalid. Control reads the file once, when the project is made, so change a running project in its settings. Who uses each key of the config:

| Key | Used by |
| --- | --- |
| `instructions`, `skills` | The coordinator, from its copy of the repo (**The repo copy**, below). Engineers and verifiers, from their clone |
| `commands` | The coordinator and engineers are told them. Engineers and verifiers run `setup` in their clone before their agent starts. Verifiers start `dev` and open `devUrl` |
| `verify` | Verifiers: the skill they follow (**Verifiers**, below) |
| `connectors` | The coordinator, engineers and verifiers, through control (**Connectors**, below) |
| `mcp` | Engineers and verifiers, in their clone |
| `secrets` | Names only. Members set the values (**Secrets**, next), which reach engineers and verifiers only, one task each |
| `workers.max` | Control: how many engineers and verifiers run at once (**Engineers**, below) |

**Secrets** are values for the names `secrets` declares. Any member sets, replaces or clears one in **Settings** (`PUT` and `DELETE /projects/:id/secrets/:name`). Control keeps the value in its `SecretStore`, scoped to the project, under a new name each time it is written. The secret points at the new value only once it is saved, and the old value is deleted after that. A write that fails leaves the secret's last value. A project's writes, clears and deletion run one at a time. A value control fails to delete is noted in SQLite and deleted when control next starts. Control never sends the value back to the desktop and never puts it in a log or event. `GET /projects/:id/secrets` lists only names and whether each is set. A value whose name the config stops declaring stays, marked as no longer declared, until a member clears it. Deleting the project deletes its settings and every secret value. Only the project's engineers and verifiers get the values, each for one task (**Engineers**, below).

Each project gets one computer from the `ComputerProvider` (`chiefbot-<project id>`), which runs the project's agent, its **coordinator**, instead of a bot worker. The app shows it under the project's name. The coordinator plans and tracks work and never writes code: it runs the Copilot SDK in `mode: "empty"` (no shell, no file writes, no ambient config) with its own tools only.

- **It can** read the repo's default branch, fetched fresh each turn, with `repo_read` and `repo_search`, and follow the repo's instructions and skills (**The repo copy**, below). It can start a read-only `explore` helper (**The explore helper**). It keeps the task ledger and the shared context (`create_task`, `update_task`, `list_tasks`, `read_context`, `write_context`). It dispatches, watches and stops engineers and verifiers, and moves a task on when one ends (**Engineers**, **Verifiers** and **The task goes on by itself**, below). It calls the project's connectors that are ready for the member whose turn it is (`docs/connectors.md`).
- **It cannot** run a command, change a file, push or open a pull request: engineers do. It reads no branch but the default one: a verifier checks a pull request's commit. It never sees a secret's value, and the `mcp` servers run in engineers and verifiers only. It cannot mark a task done that links a pull request without a verifier's PASS for its head (**The done rule**). It asks you through a task's question, not a question card, and its chat takes no files.

Control serves the ledger, context, engineer and verifier tools and the connectors. The coordinator serves `repo_read` and `repo_search` itself, over its copy of the repo. The **task ledger** in control's SQLite is the only record of task state (open, in progress, needs input, done, abandoned; the question a task waits on while it needs input, which the coordinator sets with the status; an owner, who asked, and links to pull requests, context files or pages). **Shared context** is a set of Markdown files every agent of the project reads and adds to (`notes.md`, `docs/`, `plans/`), kept by control in a `ContextStore`: a `context` folder next to the database now, a bucket later. Each member has their own chat with the coordinator. Who pays for its Copilot is the workspace's choice (**Copilot for projects** on the **Members** screen; `PUT /workspaces/:id/copilot-mode`). By default each turn runs on the seat of the member who asked: control brokers a token only for the member whose turn is running. In org mode each turn runs on a one-hour installation token of the repo app that control mints with only `copilot_requests: write` and one repository id, billed to the account that installed the app on the project's repo; it cannot read or write any repo. The coordinator passes it to a Copilot runtime of its own as `COPILOT_GITHUB_TOKEN` with `useLoggedInUser: false` (never through `gitHubTokenProvider`, which GitHub reserves for user tokens). Each turn resumes the member's session on a runtime of its own (so every callback in it acts in that turn only: `docs/isolation.md`), started on the latest token while it has over 20 minutes left, otherwise on a new one; the conversation is kept. A turn still running five minutes before its token expires is cut short and continues on a new token and runtime with `continue`. A member's session moves between seat and organization, keeping its history, when the owner switches the mode. Org billing changes only who pays for Copilot: the project's connectors still act as the member who asked (or as the workspace, for a shared one). Each turn's chat starts with a line saying who pays (`On octo-user's Copilot seat`, `Billed to octo-org's Copilot (organization)`). Control picks the payer for every agent run in one place (`apps/control/src/copilotIdentity.ts`): chiefs always use their owner's seat. One scheduler per project runs the coordinator's turns one at a time across all members' chats, oldest first, so each turn sees the tasks the turns before it made, and two members asking for the same thing get one task. The desktop shows the ledger beside the chat and updates it live.

**The repo copy.** At the start of each turn the coordinator fetches the repo's default branch (one commit, no history) into `/home/bot/repo` on the project's computer, through control's git proxy with the turn's key. Control lets a coordinator's key only fetch, and only its own project's repo, as the member whose turn it is, so a member whose GitHub account cannot see the repo cannot read it through the coordinator either. The chat shows the fetch as a tool call, **Fetch owner/repo**. A fetch that fails shows as failed, the copy is removed so no turn reads an old one, and the coordinator's tools and instructions say why. The coordinator refreshes the copy for one turn at a time, and a member who leaves while their turn fetches has that fetch stopped, with every git process it started. Git runs with no hooks, no fsmonitor and no background gc, whatever the copy's own `.git/config` says. `repo_read` reads a file, 500 numbered lines at a time from its first 1 MB, or lists a folder. `repo_search` searches the text of the commit's files for a regular expression (`git grep -E`) and answers `path:line:text`, at most 200 matches. Both read the fetched commit's objects in git, not the folder, so nothing done to the folder changes what they answer. Both refuse a path outside the repo, and they follow a symlink only to the repo's own files and folders. The copy checks out symlinks as plain files (`core.symlinks=false`), so the runtime's skill loader has none to follow out. Each turn the coordinator is told the repo's `AGENTS.md`, `.github/copilot-instructions.md` and the config's `instructions` files, at most 20,000 bytes of each, and it loads skills from the config's `skills` folders in the copy. Each configured path is looked up in the commit as it is written. A folder that is a symlink holds nothing there, so `alias/skills` is not found when `alias` links to `real`: write `real/skills`. A configured path that is missing, or is a folder where a file belongs (or the other way round), is skipped. The fetch row names it with why (`Fetch owner/repo · skills path alias/skills not found in the repo at 4f2c9e1; use the real path, not a symlink`), and so does the coordinator's prompt. The runtime's skill tool and task tool (below) are the only built-in tools it gets. So it answers "where is X rendered?" with file paths, and no engineer starts.

**The explore helper.** For a question that takes many reads, the coordinator can start a helper inside its own session: `explore`, one of the SDK's custom agents, which the model starts with the runtime's `task` tool (`exploreAgent` in `apps/worker/src/repoCopy.ts`). The helper reads in a context window of its own, with `repo_read` and `repo_search` and no other tool, and answers the coordinator with the files it found. The session's config names the helper, adds the task tool and tells the coordinator about it (`coordinatorSessionConfig` in `apps/worker/src/copilotSdk.ts`). A pre-tool hook checks again before each call a helper makes: a helper may call only the tools its agent names. Its calls also go through the coordinator's permission check, as the coordinator's own do. Each session turns off the runtime's built-in agents (task, research, rubber-duck and more; `includedBuiltinAgents: []`), which would get every tool of the session, so `explore` is the only helper the task tool starts. If the runtime rejects that, or does not answer `success: true`, the session closes and opens again without the helper, without the task tool and without a word about the helper, and the turn runs. Every later session on that computer then opens without the helper, and the computer's log says so once. The chat shows the helper as one row, `explore: <its job in a few words>`, without the calls it makes, and no engineer starts.

**The project's model.** The project's message box has the same model and effort pickers as a bot's (**Auto** at first). Any member picks among the models of their own Copilot plan (`PUT /projects/:id/model`), for every member's turns with the coordinator. Each turn reports its plan's models to control, as a bot's computer does: the member's, on their own seat, which the picker then lists, or the organization's, when it pays. A report counts for whoever paid when the turn started, even if the workspace changes who pays while it runs. A turn runs on the project's model only when the plan of who pays for it offers that model, by the latest report. Otherwise it runs on Auto, and its chat says why under who pays. A plan without the model, such as Copilot Free, gets `Claude Sonnet 4.6 isn't on octo-friend's plan; this turn ran on Auto.` A plan no turn has reported yet (before the member's first turn) gets `octo-friend's plan isn't known yet; this turn ran on Auto.` A turn runs at the picked effort while the plan of the member whose turn it is offers it for that model, else at the model's default. Engineers do not use it.

**The Projects tab.** It lists the current workspace's projects under its **Members** and **Connectors**, each with a dot for the project's state for you: green while idle, pinging while its coordinator or an engineer works, amber **needs you** while a task asks you a question or an engineer waits on your approval, and grey **sleeping** while its computer is stopped. Control sends each member all their states on `/events` when it connects, and again when a project is deleted or they leave a workspace (`project-states`, which replaces what the desktop had), and each change on its own (`project-state`). A project opens on your conversation with its coordinator (the composer says **Message <project name>**), with a panel on the right in three tabs, which the arrow keys move between: **Tasks**, the ledger, with each task's engineers (the agents a project starts are called engineers in the app) and verifiers, what they wait on, their pull requests and the verifier's verdict; **Engineers**, newest first, where **Open** on one shows its transcript and, while it works, its live screen, which any member of the project watches, as a bot's. One member at a time takes control: the others see **<login> is in control** and their clicks and keys never reach it. A paste over 1 MB closes the screen. Control goes back to the engineer when that member clicks **Stop**, closes the screen or leaves the workspace; and **Context**, the shared notes with verifiers' screenshots, read-only. The panel button at the top right hides the panel. The gear opens the settings, which end with **Delete project** for the workspace owner. Control serves the panel (a session; 404 to anyone outside the project's workspace): `GET /projects/:id/context` lists the context files, `GET /projects/:id/context/file?path=` returns one and `GET /projects/:id/context/image?path=` one of its PNG images, `WS /projects/:id/workers/:workerId/transcript?after=<seq>` streams an engineer's transcript, and `WS /projects/:id/workers/:workerId/screen` with `POST …/take-over` and `…/hand-back` drive its screen like a bot's (409 `worker_offline` while its worker is not connected, `screen_not_open` for a take-over without the screen open, `screen_taken` while another member drives). A member's screens and transcripts close when they leave the workspace or the project is deleted.

**Engineers.** The coordinator gets a task done by dispatching an **engineer** (a task worker in the code): one task on one throwaway computer (`chiefbot-worker_<id>`) from the `ComputerProvider`, result a draft pull request or a report. It has five more tools for this, all served by control (`apps/control/src/taskWorkers.ts`): `dispatch_worker` (a task number and optional instructions), `dispatch_verifier` (**Verifiers**, below), `worker_status`, `worker_transcript` and `stop_worker`. Control first writes a launch record keyed by a creation id, the coordinator's tool call id, and only then asks for the computer, so a resent dispatch finds the engineer it started instead of making a second one. A project runs at most `workers.max` engineers and verifiers at once (default 2). A dispatch beyond that is **queued**, with no computer: the tool answers a queued engineer and the task shows why. An engineer keeps its place until its computer has stopped after its turn, or is gone: a stop or removal that fails is tried again every 30 seconds and when control starts. Queued engineers launch oldest first as places free. A task has at most one engineer or verifier at a time that is queued, setting up or working, so its own engineer never pushes while its verifier checks.

Before its agent starts, an engineer **sets up** (the task shows **setting up**). Its worker clones the repo's default branch into `/home/bot/workspace/<repo name>` through control's git proxy, then runs `commands.setup` there with `sh -c`, with the project's secrets in its environment. Each step goes into its transcript before the agent's first message, and shows on the task: its command, its exit code and the end of its output (16 KB at most), the log of a failing step open. A step that fails ends the engineer **blocked**, and its agent never starts. So does a computer whose image predates setup: its worker does not announce `engineer-setup`, and the result asks you to rebuild the image (`bun run computer:build`). The agent then starts in the clone. Its session is told the setup command, the secrets' names (never their values) and the repo's instruction files: `AGENTS.md`, `.github/copilot-instructions.md` and the `instructions` files, each that exists, up to 64 KB each. It loads the skills in the `skills` folders the clone has, and runs the `mcp` servers in the clone without asking (a connector of the same name wins). An instruction file or skill folder that leads outside the clone through a link, or a skill folder that holds such a link, is left out. The secrets reach that one task only: control reads them when the task starts and sends them with it, only if the turn still runs, its member is still in the project and the worker is on the connection that asked; never to the project's computer or its coordinator. The setup command and the agent's own Copilot runtime (so its shell) get them as environment variables, and that runtime stops when the turn ends. The worker hides each value in all it sends control (`apps/worker/src/secretRedactor.ts`): setup output before it is cut, the agent's messages (one split across deltas or around a tool row too), tool rows and errors, so no transcript or task result keeps one. This catches accidents: `env` output, a test that logs a token, an error that echoes a header. It cannot stop an agent that re-encodes a secret on purpose, because the agent already holds the value. So it covers the forms GitHub Actions masks, and no more: a value as it is, URL-encoded, in base64 (inside longer base64 too, where a few characters at each end still show), and each line of 6 or more characters of a multi-line value. A value under 6 characters is hidden only as it is. Each stretch any form covers, overlaps included, becomes one `***`. A message's last characters wait in the worker until they cannot start a secret, or the message is over, so messages keep their order. Its `create_pull_request` refuses a pull request with one in its repository, branches, title or body. The engineer's brief tells it to reproduce the problem on the base branch first. Then it pushes a branch and opens a pull request, which control always opens as a draft, or, when nothing needs to change, it pushes nothing and ends with a report. The task shows its last message (its report, or the pull request's summary) under it. A later environment of services for each engineer (a database, backend services, a seed step) plugs into this setup stage.

The engineer is a bot's worker on control's `/task-worker/<id>` routes: it runs the task as one turn on the Copilot SDK in `copilot-cli` mode, for the member whose message dispatched it: on that member's seat, or in org mode on the organization's installation token, as the coordinator does (control picks it in `copilotIdentity.ts`; the ledger shows who pays). In org mode a task may outlast its token's hour: five minutes before the token expires, its worker cuts the SDK turn short, fetches a new token, restarts the runtime on it, resumes the same session and sends `continue`, so the task runs on as successive SDK turns (`apps/worker/src/installationSession.ts`; the coordinator does the same). An approval the cut runtime waited on is withdrawn (its card shows **Withdrawn**), and so is one control held for a request the runtime dropped, so its wait limit cannot stop the engineer. Continuing, the agent asks again if it still needs it. The project's connectors reach the engineer as they reach the coordinator: through control's proxy at `/task-worker/<id>/mcp/<name>`, as the member who asked, each call logged. It fetches and pushes through control's git proxy with its turn's key, and each push and its `create_pull_request` wait for that member's approval, shown as cards under the task in the ledger (`POST /projects/<id>/workers/<worker id>/approvals/<approval id>`; only that member may answer). The pull request it opens is linked on the task. An engineer that waits on one approval for over an hour (`CHIEFBOT_APPROVAL_WAIT_MINUTES`) fails, so it costs nothing while nobody answers: control stores when each approval was asked and re-arms the limit when it restarts. Its computer stops as soon as its turn ends (finished, blocked or failed), keeping its disk, and is deleted, disk and all, when the coordinator stops it, when the task is marked done or abandoned, or when the project is deleted. An engineer whose computer restarts mid-task fails. When control starts, it stops every engineer's computer whose turn ended but still runs, and deletes every one that should be gone (a delete that failed, or a launch the restart cut short).

**Verifiers.** A **verifier** checks a task's pull request with fresh eyes before the task is done. The coordinator starts one with `dispatch_verifier`: a task number, optionally one of the pull requests the task links (its latest by default), and instructions. A verifier is an engineer (`kind: "verifier"`) with four differences. First, it gets a new computer of its own, never the engineer's. Second, control reads the pull request's head on GitHub when the verifier is dispatched, as the member who asked, and pins that commit: the verifier's setup clones the repo, checks the commit out (`checkout: git fetch -q origin <sha> && git checkout -q --detach <sha>`) and then runs `commands.setup`. Third, control refuses its pushes (`A verifier may only fetch <repo>.`) and its pull requests (403 `verifier_read_only`). Fourth, it ends with a verdict, not a pull request: its `report_verdict` tool sends **pass**, **issues** or **blocked**, a summary, a report and up to 6 PNG screenshots of at most 2 MB each (`POST /task-worker/<id>/verdict`, once per verifier). Its brief has the task, the pull request's URL, commit, title and body, and how to check it. That is the repo's `verify` skill when the config names one, with `commands.dev` and `commands.devUrl` when they are set, since the app's settings may set them where the repo does not show them. Otherwise it is a short playbook for any web app: start `commands.dev` in the background, wait until `commands.devUrl` answers, open it in Chromium, use the change the pull request describes, save a screenshot of each check (`scrot`) and report. With no `dev` and `devUrl`, it checks with the tests and the code, and says so. Control writes the report into the project's context as `verify/task-<n>-<commit>-<verifier>.md`, with the screenshots beside it as PNGs, so they outlive the verifier's computer. Then it sets the task's **verification**: the result, the commit, the summary, the pull request and branch, and the report's path. The worker hides the project's secrets in the summary and report. It cannot hide them in screenshots, so give a project dev keys only. Its brief tells it to keep secrets, environment pages and developer tools that show tokens out of them. A verifier that ends without a verdict is **blocked**, with the reason: its setup failed (its log is the report), its computer runs an image without verifiers (rebuild it), or it ended without calling `report_verdict`. A stopped verifier gets no verdict. Verifiers take `workers.max` places as engineers do. They run the same full computer, with Chromium and the app's dev server, and that computer is what the limit protects.

**The task goes on by itself.** When an engineer or a verifier ends (finished, blocked or failed; not stopped), control queues one turn for the coordinator in the chat of the member who requested the task. It is paid as that member's own turns are: on their seat, or on the organization's Copilot when the workspace says so (**Copilot for projects**). Their chat shows it as a system line, not as their message: `Engineer for task #1 ended: opened <pull request URL>.` or `Verifier for task #1 ended: PASS for <pull request URL> at <short sha>: <summary>.`, then `Continue the task: dispatch the verifier on its PR, send fixes for ISSUES, or mark it done after a current PASS.` So a request ends in a verified pull request with nobody's nudge. Each ending queues one turn, keyed by the engineer's or verifier's id: a control restart neither repeats it nor loses it, and one that ended as control stopped is queued when it starts. A message the member sends meanwhile is never refused for it: it queues behind. A task gets at most 6 of these turns. After that, each ending sets it to **Needs input** (`Automatic steps used up: tell the project how to go on.`) instead. Nothing is queued for a task that is done or abandoned, or whose requester left the workspace, and a queued turn whose task closes first (a member's **Mark done**) ends without running, so it cannot reopen the task.

**The done rule.** The coordinator cannot mark a task done when it links a pull request and has no **pass** for that pull request's current head. A task with no pull request has nothing to verify. When the coordinator sets done, control reads the head again on GitHub, so a push from anywhere counts. It refuses with the reason: no verdict, issues, blocked, or a head that moved since the pass. A pass whose head moved is **stale**. A push through Chiefbot's git proxy to the pull request's branch marks it stale at once. So does one whose answer from GitHub is lost or a server error (5xx), since it may have landed, and one that was in flight when control stopped. A verdict arrives stale when such a push was in flight while control pinned its commit, or started since. Only a new verifier's verdict makes it current again. When control cannot read GitHub, it refuses the done. So it does when a push through Chiefbot to the branch is in flight, or lands while control reads GitHub (`… its pull request moved while Chiefbot checked it. Verify it again.`). Control counts the pushes to each branch that started and those still in flight, and writes the done only if none is in flight, none started since its check, and the pull request and its pass are unchanged. A new pull request linked on a done task reopens it (in progress), so done needs a pass for it. A task done with a report and no pull request stays done. A member can override this: **Mark done** under the task (`POST /projects/:id/tasks/:number/done`; 409 `task_closed` once it is done or abandoned) marks it done, and the task records who did it, when, and its verification then. The task shows **Verified PASS @<short sha>**, **ISSUES @<short sha>** with the issues, or **BLOCKED @<short sha>** with the reason, then **· stale** once the pull request has moved. **Report** opens the report in **Context**.

**Connectors** are MCP servers a workspace defines once (GitHub, GitHub Actions and Jira are presets). A project's agents get only the connectors its config declares (its `chiefbot.project.yaml` or its settings), each call running as the workspace's service credential or as the member who asked, and every call is logged. Each member's **Connectors** screen is their access checklist: what their projects need minus what they have connected. See `docs/connectors.md`.

**Subscriptions.** A project can listen to events: CI runs failing on a branch, new or updated results of an issue-tracker query, and schedules. Open **Listening to** in a project's header to add or remove them; any member can. Control polls CI and issue queries itself, every few minutes (5 by default, 1 at least), through a remote connector the project declares: GitHub Actions' `actions_list` for CI, GitHub's `search_issues` or Jira's `searchJiraIssuesUsingJql` for issues. Each poll runs as the workspace's credential, or for a personal connector as the member who added the subscription, and shows in **Connector calls**. A schedule is a prompt with a cron expression, run like a routine. Each event has a stable id (a CI run and its conclusion, an issue and when it was updated, a due time), stored in control, so it becomes exactly one task in the ledger and one message to the coordinator in the adding member's chat, even across control restarts. The first poll only notes what is already there. A subscription whose member leaves the workspace pauses.

**Handoffs.** Your own bot is also your chief of staff: it can hand work to a project of any workspace you belong to, and it never sees other projects. It has four tools, served by control (`POST /worker/<bot id>/chief-tools`): `list_projects`, `send_to_project` (a title, the request and an acceptance condition: how you will know it is done), `message_project` (a follow-up to a handoff) and `handoff_status`. Sending creates a handoff record in control (who asked, the project, the request, the acceptance condition, the linked task) and a task in the project's ledger, asked by you. The coordinator gets it as a message in your own chat with it, through the project's scheduler, so it runs on your Copilot seat like any message of yours, queued behind one you already sent. A follow-up reaches the same task and the same chat, never a new task: control adds it to the task's detail and the coordinator gets it as "About task #N, from your chief of staff". Control delivers each follow-up once, keyed by its tool call's id, so a runtime that sends the call again adds nothing. Once the task is done or abandoned, the handoff takes no more follow-ups: control refuses them, and new work is a new handoff. While the project asks a question, every message from the chief names it (from `handoff_status`). Control refuses a message that names another question, or none, and says what the project asks now, so the chief can check with you. The chief only starts and watches: the coordinator plans the work and manages its engineers and verifiers, moving the task on as each ends. A handoff's status is its task's status in the ledger. `handoff_status` also gives the question the project asks while the task needs input, the task's engineers and verifiers, its links, the verdict the card shows (below) and the coordinator's last reply to a message of the handoff. The chief's chat shows one card per handoff, where the work was handed over, that control keeps up to date: **Accepted**, **Working**, **Needs your input** with the question, **Pull request opened**, **Verified** (a verifier passed the pull request's head), **Done** or **Abandoned**, with the task's pull requests, the verifier's verdict on the latest one (**Verified PASS @<short sha>**, **ISSUES** or **BLOCKED** with its summary, **· stale** once the pull request moved) and **Open in Projects**. While the project needs your input, the card has a box for your answer, which reaches the same task and chat as a follow-up does (`POST /bots/<id>/handoffs/<handoff id>/messages`). The answer carries the question you started it for. If the project asks something else by the time it arrives, control refuses it, and the card keeps your answer and shows the new question. An answer sent again unchanged is delivered once, and an edited one is a new answer. Each change of a card is stored in the chief's chat, so cards survive a restart of control and the desktop, and a change a crash kept from the chief is posted when control starts again. A handoff from before cards keeps its notices and gets a card at its task's next change. If you leave the workspace, your chief sees and hears nothing more of its handoffs there.

**Not yet.** These are out of scope for now:

- Projects read a private repo, push and open pull requests only through your repo app, a GitHub App on github.com. Only a public repo can be read without it. A host reached with a personal token instead (GitHub without the app, GitHub Enterprise, GitLab or Bitbucket) does not work yet.
- Copilot sign-in takes GitHub's device flow, not a token.
- Computers have no proxy or corporate CA (certificate authority) settings.

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
| `CHIEFBOT_APPROVAL_WAIT_MINUTES` | control | `60`: a project's engineer waiting this long on one approval fails and its computer stops, keeping its disk. The limit survives a control restart |
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
2. While its computer starts, the **Computer** tab of its panel (right of its chat) shows the bot's face looking around under **Waking up…**. When the bot is **online**, the tab shows its screen: a 1280×800 desktop with a dock at the bottom that opens Chromium, Files and Terminal. Nothing is open yet. The pill under it says **Watching | Take control**. Clicks and keys in the pane do nothing.
3. `docker ps` shows no published port for the bot's container.
4. Click **Take control**. The screen gets a green ring and the pill says **You're in control | Stop**. Click **Terminal** in the dock. A terminal opens in `/home/bot/workspace`. Type in it. The text appears. **Files** opens the same folder, and **Chromium** opens the browser. The chat box says **Hand the screen back to message …** and will not send.
5. Click **Stop**. Typing in the pane does nothing again, and the chat sends.
6. Click the expand button beside the pill. The screen fills the window, with the same pill under it, and stays connected. Press Esc: it goes back to the panel. Open it again, click **Take control**, click into the screen and press Esc: Esc goes to the bot's computer, and full screen stays. Click the collapse button at the top right to leave.
7. Stop the bot on **Details**. The **Computer** tab shows its face with shut eyes, **Going to sleep…**, then **Asleep**. Click **Wake**: it shows **Waking up…**, then the screen.

Take-over lives in control's memory, so restarting control hands the screen back to the agent. A chat turn already running when you take over pauses at its next tool call and goes on after hand-back. A `computer` call already running stops before its next action.

## Manual check: the bot operates its own screen

Tests use a fake display and a fake Copilot, so no test shows a model reading a screenshot. This check makes **one** real Copilot chat on your plan.

1. Run `bun run computer:build` (the image carries xdotool and scrot), then `bun run dev`. Sign in with the GitHub account that has Copilot.
2. Create a new bot and wait until it is **online**. Leave it on **Auto**, with a model that does not say it cannot see images.
3. Open its **Computer** tab, then send `Open Google in Chromium on your computer, search for Chiefbot, and describe what the results page shows.`
4. The pane shows the bot open Chromium from the dock, go to Google and search. The chat shows tool rows such as `computer: key, type, key, wait`, and the reply describes the results page.
5. If the rows succeed but the reply says the bot cannot see the screen, the model dropped the tool's screenshots. Note the model: the fallback is to write the screenshot to a file and have the model `view` it.

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
6. On a paid plan only, with a model that shows an effort picker: pick a level other than its default and send the same message. The turn should answer without an error (the runtime refuses a level the model does not support).

## Manual check: an image and a document in a message

Tests use a fake Copilot, so no test shows what a model makes of a file. This check makes **one** real Copilot chat on your plan.

1. Run `bun run computer:build`, then `bun run dev`. Sign in with the GitHub account that has Copilot.
2. Create a bot (or pick one) and wait until it is **online**. Leave it on Auto, or pick a model that does not say it cannot see images.
3. Copy a screenshot to the clipboard and paste it in the message box. Click the paperclip and pick a small text file. A thumbnail and the file's chip show.
4. Type `What is in the image, and what is the first line of the file?` and press Enter. Your message shows the thumbnail. The reply describes the image and quotes the file's first line.
5. Run `docker exec chiefbot-<bot id> ls -R /home/bot/workspace/attachments`. It lists one folder for the turn, with both files.

## Manual check: a bot asks you a question

Tests use a fake Copilot, so no test shows a real model fill in Copilot's `ask_user` form. This check makes **one** real Copilot chat on your plan.

1. Run `bun run computer:build` (the image carries the worker that asks), then `bun run dev`. Sign in with the GitHub account that has Copilot.
2. Create a bot (or pick one) and wait until it is **online**. Any access mode works.
3. Send: `Before you do anything else, use your ask_user tool to ask me three questions in one form: the language (pick one of TypeScript, Python, Go), the checks to add (pick any of tests, lint, CI) and the project's name (free text). Then reply with one line that repeats my answers.`
4. A **Question** card shows **1 of 3**, and the status line says **Waiting for your answer**. Press `1` to pick the first option, then click **Next**.
5. On **2 of 3**, tick two options and type `and a smoke run` in **Comment**. Click **Next**.
6. On **3 of 3**, type `Atlas`. Reload the window (Cmd+R) before you submit. The card comes back on **3 of 3** with `Atlas` typed. Click **Submit answers**.
7. The card shows your answers, read-only. The bot's reply repeats your language, both checks with `and a smoke run`, and `Atlas`.
8. If no card shows and the bot asks in plain text, the model did not use the tool: note the model. If the card shows but the reply says no answer came, run `docker logs chiefbot-<bot id>` and note any line about `elicitation`.

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

1. Pick a repo your repo app is installed on. It needs no `chiefbot.project.yaml`.
2. Run control and the desktop apart (`bun run --cwd apps/control dev`, `bun run --cwd apps/desktop dev`) and sign in as the workspace owner. Pick the workspace in the switcher.
3. In the **Projects** tab, click **New project** (the folder icon beside **Search projects**), type the repo as `owner/repo` and click **Create**.
4. The project opens with an empty conversation and an empty **Tasks** tab in the panel. Its dot in the list is green.
5. Send: "We need a dark mode toggle in settings. Track it as a task." The reply comes back and the task appears under **Tasks** as #1, asked by you.
6. Start a second desktop as the member (`bun run --cwd apps/desktop dev -- --user-data-dir=/tmp/chiefbot-second`), open the project and send: "Can we get dark mode in the settings page?" The coordinator answers that task #1 already covers it. The ledger still shows one task in both desktops.
7. In the second desktop send: "Mark the dark mode task as in progress." Both desktops show #1 **In progress** without a reload.
8. In the second desktop the project's settings (the gear) have no **Delete project**: only the owner deletes. In the first desktop open the settings, click **Delete** and confirm. The project leaves the list and `docker ps -a` no longer lists `chiefbot-project_…`. Clean up: `rm -rf /tmp/chiefbot-second`.

## Manual check: a repo with no project file, its settings and secrets

Tests use a fake GitHub. This check uses the real GitHub and Docker and makes no Copilot call. It needs the computer image (`bun run computer:build`).

1. Pick a repo your repo app is installed on that has no `chiefbot.project.yaml`. In a second one, commit a `chiefbot.project.yaml` with a typo: `conectors: [github]`.
2. Run control and the desktop apart (`bun run --cwd apps/control dev`, `bun run --cwd apps/desktop dev`), sign in and pick a workspace.
3. Click **New project** and type the first repo. Within a minute the project opens. Its header shows a **No project file** badge, and **Settings** says "No project file, using app settings".
4. Click the gear. **Config** lists every key, each from **default**. Under **Settings**, type `commands: { setup: bun install }` and `secrets: [DEMO_TOKEN]` on two lines, then click **Save**. **Config** shows `commands.setup` and `secrets` from **settings**.
5. Save `workers: { max: 0 }` instead. The form shows `invalid_settings` naming `workers.max`, and **Config** does not change.
6. Under **Secrets**, `DEMO_TOKEN` says **Not set**. Type `demo-secret-value-1` and click **Set**: it says **Set** and the field empties. Type `demo-secret-value-2` and click **Replace**.
7. Check the value is only in control's secret store, sealed. `cat apps/control/.data/control.sqlite* | grep -c demo-secret-value` prints `0`. `docker exec chiefbot-<project id> sh -c 'env; cat /proc/*/environ 2>/dev/null' | grep -c demo-secret-value` prints `0`.
8. Click **Clear**: `DEMO_TOKEN` says **Not set**.
9. Click **New project** and type the second repo. The project is made. Its header shows an **Invalid project file** badge, and **Settings** shows `Unrecognized key: "conectors"`.
10. Clean up: delete both projects. `docker ps -a` lists no `chiefbot-project_…` of them.

## Manual check: a project answers from its repo, on its own model

Tests use a fake Copilot and a fake GitHub. This check uses the real GitHub and Docker and makes **four** Copilot chats. It needs the computer image (`bun run computer:build`).

1. Pick a private repo your repo app is installed on, with no `chiefbot.project.yaml`, an `AGENTS.md`, and a page or component you can name. Run control and the desktop apart (`bun run --cwd apps/control dev`, `bun run --cwd apps/desktop dev`), sign in and pick a workspace.
2. Click **New project** and type the repo. Within a minute the project opens.
3. Send `Where is <the component> rendered? Answer with file paths.` The turn shows **Fetch owner/repo** with a tick, then a `repo_search` or `repo_read` call. The reply names files of the repo. `docker ps` lists `chiefbot-project_…` and no `chiefbot-worker_…`.
4. Send `What does AGENTS.md ask of you? One sentence.` The reply sums up the repo's `AGENTS.md`.
5. Push a commit to the default branch. On a paid plan, also click the model name under the message box and pick a model, and an effort if it shows one: the list holds your plan's models since your first turn. Send `Reply with one short sentence: which model are you?`. `docker exec chiefbot-<project id> git -C /home/bot/repo log --oneline` shows the pushed commit. On a paid plan the reply names the picked model's family.
6. Uninstall the repo app from the repo (or remove the repo from the app's repositories) and send `Where is <the component> rendered?`. **Fetch owner/repo** shows as failed, `/home/bot/repo` is gone from the project's computer, and the reply says the repo could not be fetched. Install the app again.
7. Clean up: delete the project.

## Manual check: the project's explore helper

Tests use a fake Copilot, a stand-in for the Copilot runtime and a fake GitHub. This check uses the real GitHub and Docker. You send one message, but the helper's own model calls may count as more requests on your plan. It needs the computer image (`bun run computer:build`).

1. Set up a project for a repo, as in the check above (steps 1 and 2), or reuse it.
2. Send `Use your explore helper to find every file that reads an environment variable. Then name the agent types your task tool can start.`
3. The turn shows **Fetch owner/repo** with a tick, then a row `explore: <a few words>` that turns from a spinner to a tick. Finished rows may fold under **Ran N tools**: open it to see them. The helper's own `repo_read` and `repo_search` calls show no rows. The reply lists files of the repo. `docker ps` lists `chiefbot-project_…` and no `chiefbot-worker_…`.
4. The reply should name `explore` as the only agent type. That is the model's own account, so it supports the check but does not prove the built-in agents are off.
5. If there is no `explore` row, run `docker logs chiefbot-<project id> 2>&1 | grep "built-in agents"`. A line saying the runtime would not turn off its built-in agents means sessions on that computer run without the helper, and the reply came from the coordinator's own reads. A row named just `task` means the runtime's task call had no `agent_type` or `description` that Chiefbot could read. Note the error and the row.

## Manual check: connectors, the checklist and the call log

Tests use a fake MCP server and a fake Copilot. This check uses the real GitHub MCP server and Atlassian's, and makes 5 live Copilot calls. It needs Docker, the computer image rebuilt with this code (`bun run computer:build`), a project as in the check above, and a Jira site you can sign in to.

1. Open the project's settings (the gear), type `connectors: [github, jira]` under **Settings** and click **Save**. **Config** shows `connectors` from **settings**.
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
5. Open the bot's **Details** tab. **Connection calls** lists `acli jira auth`, `acli jira workitem search` and `acli jira workitem` (a write shows only the subcommands a read-only entry names).
6. Click **Disconnect** on Jira and send "List my open Jira issues" again. The bot has no Jira skill and `acli` is not signed in.
7. Clean up: delete the issue in Jira.

## Manual check: a chief of staff hands work to a project

Tests use a fake Copilot. This check makes about 9 live Copilot calls on the real GitHub with one account. It needs Docker and the computer image rebuilt with this code (`bun run computer:build`).

1. Set up a workspace and a project, as in the check "two members ask a project's coordinator for the same thing" (steps 1 to 4). Create a bot and wait until it is **online**.
2. In the bot's chat send: "Hand the <project name> project this: add a dark mode toggle to the settings page. It is done when a pull request adds the toggle." The chat shows `send_to_project` succeeding (it may call `list_projects` first) and a reply naming the task number, say #1. A card shows where it was sent: **Accepted**, the task's title and "Handed to <project name> · task #1".
3. In the bot's chat send: "Tell that project the toggle also goes in the mobile menu." The chat shows `message_project` succeeding, and no second card.
4. Open the project. Your chat with the coordinator shows a message from your chief of staff about task #1 with "Done when: …", then "About task #1, from your chief of staff:" with the mobile menu, each with the coordinator's reply. **Tasks** shows one task, #1, asked by you.
5. In the project chat send: "Set task #1 to needs input and ask me which settings page." **Tasks** shows #1 asking it. Back in the bot's chat, the card, still where it was, says **Needs your input** with the question and a box to answer it. It changes even if the bot was mid-reply or stopped.
6. Type "The account settings page" in the card's box and click **Send answer**. The card says "Sent to <project name>". Click **Open in Projects**: the project opens, and your chat shows "About task #1, your answer from your chief of staff's chat:" with your answer and the coordinator's reply. **Tasks** still shows only #1.
7. In the project chat send: "Add the link https://github.com/<repo>/pull/1 to task #1 and set it in progress." The card says **Pull request opened** with "Pull request #1". No verifier checked that pull request, so the coordinator cannot mark the task done (**The done rule**). Use the member's override instead: click **Mark done** under task #1. The card says **Done**.
8. In the bot's chat send: "How is the dark mode handoff going?" The chat shows `handoff_status` and a reply saying it is done, with the pull request and what the coordinator last said about it. Then send: "Tell that project the toggle also goes in the footer." `message_project` fails with "Task #1 in <project name> is done: hand over new work with send_to_project", and **Tasks** gets nothing new until the chief sends it as new work.
9. Restart control and the desktop. The bot's chat shows one card for the handoff, **Done**, where it was handed over. Clean up: delete the project and the bot.

## Manual check: a project's engineer sets up, then ends in a draft pull request or a report

Tests use a fake Copilot, fake computers and a fake GitHub. This check uses the real GitHub and Docker and makes about 20 to 25 live Copilot calls (coordinator turns, one per engineer that gets past its setup, and the coordinator's turn after each engineer that ends without being stopped: **The task goes on by itself**). It creates a repo, branches and a draft pull request on your account: delete them at the end.

1. Create a disposable repo with a README: `gh repo create chiefbot-worker-check --private --add-readme`. Install your repo app on it.
2. Run `bun run computer:build` (this code must be in the image), then control and the desktop apart (`bun run --cwd apps/control dev`, `bun run --cwd apps/desktop dev`). Sign in, pick a workspace and create a project from the repo.
3. Click the gear. Under **Settings**, type `commands: { setup: "echo token=$DEMO_TOKEN; test -f README.md" }`, `secrets: [DEMO_TOKEN]` and `workers: { max: 1 }` on three lines, then click **Save**. Under **Secrets**, set `DEMO_TOKEN` to `demo-secret-value-1`. Close **Settings**.
4. Send the coordinator: `Create a task "Say hello in the README": add the line "Hello from a Chiefbot engineer" to README.md. Then dispatch an engineer on it. In this whole chat, start no verifier and no engineer I did not ask for.` The task appears under **Tasks**, and under it **Engineer: starting its computer**, then **Engineer: setting up**. Two rows follow: `clone: git clone https://github.com/<your login>/chiefbot-worker-check.git chiefbot-worker-check · exit 0` and `setup: echo token=$DEMO_TOKEN; test -f README.md · exit 0`. Open the setup row: its log says `token=***`. Then it shows **Engineer: working · On <your login>'s Copilot seat**. `docker ps` shows a new `chiefbot-worker_…` container next to `chiefbot-project_…`.
5. While it works, count the processes that hold the secret: `docker exec chiefbot-project_<id> sh -c 'grep -l demo-secret-value-1 /proc/[0-9]*/environ 2>/dev/null | wc -l'` prints `0`, and the same command on `chiefbot-worker_<id>` prints at least `1`.
6. A **Push approval** card appears under the task with `git push to <your login>/chiefbot-worker-check: <branch>`. On github.com the branch does not exist yet. Click **Approve**. The branch appears.
7. A **Pull request approval** card appears with the branch, `main (draft)` and the title. Click **Approve**. The task gets a **pull request** link, the engineer shows **Engineer: finished**, and its summary shows under it. Open the link: the pull request is a **Draft**, has the README change, and was opened by your repo app's bot account. `docker ps -a` shows the engineer's container **Exited**: its computer stopped when its turn ended, and keeps its volume. Your chat shows a system line, `Engineer for task #1 ended: opened <pull request URL>. Continue the task: …`, and the coordinator's reply, which starts no verifier, as asked.
8. Ask the coordinator: `What is the status of the engineer? Show me its transcript.` It answers from `worker_status` and `worker_transcript`: finished, the pull request, the engineer's summary, and a transcript that starts with the clone and setup lines and their exit codes.
9. A report: send `Create a task "Check the README": tell me whether README.md on main says hello. Change nothing. Dispatch an engineer on it.` No approval card appears. The engineer shows **Engineer: finished** with its report under it, and github.com shows no new branch.
10. The queue: send `Create two tasks, "Add a LICENSE file" and "Add a .gitignore", and dispatch an engineer on each.` One engineer sets up. The other shows **Engineer: queued** and `This project runs 1 engineer or verifier at once: it starts when one ends.`, and `docker ps` shows no container for it. Send `Stop the engineer of the LICENSE task.` The queued one starts: **Engineer: starting its computer**, then **Engineer: setting up**. Send `Stop that engineer too.`
11. Restart control (save a file in `apps/control`). The first engineer's container stays, stopped: its task is not done yet.
12. No verifier checked the pull request, so the coordinator cannot mark the task done. Click **Mark done** under the "Say hello in the README" task instead. It shows **Done** and `Marked done in the app by <your login> · not verified`. Within a few seconds `docker ps -a` no longer lists that engineer's `chiefbot-worker_…` container, and `docker volume ls` and `docker network ls` show nothing for it.
13. Leaked computers: create another task and dispatch an engineer on it. While it shows **working**, stop control (Ctrl-C). Mark the engineer's computer as a failed delete would leave it: `sqlite3 apps/control/.data/control.sqlite "UPDATE task_workers SET computer = 'unwanted' WHERE state = 'working'"`. Start control again. Within a few seconds its container, volume and network are gone.
14. Approval wait limit: stop control and start it again with `CHIEFBOT_APPROVAL_WAIT_MINUTES=3`. Create another task, dispatch an engineer on it and leave its **Push approval** card unanswered. After a minute restart control once more (the limit must survive it). About three minutes after the card appeared the engineer shows **failed**, its result saying it waited too long, and `docker ps -a` shows its container **Exited** with its volume kept.
15. A failing setup: in **Settings**, change the setup to `commands: { setup: "echo broken; exit 3" }` and save. Create another task and dispatch an engineer on it. It shows **Engineer: blocked**, with the setup row open on its log, `broken`, and under it ``Its setup failed: `echo broken; exit 3` exited with 3.`` No approval card appears, and `docker ps -a` shows its container **Exited**.
16. If a card never appears and the engineer shows **failed**, its result says why (a lost GitHub sign-in, the repo app not installed on the repo). `docker logs chiefbot-worker_<id>` shows the worker's side.
17. Clean up: delete the project (owner only), then `gh repo delete <your login>/chiefbot-worker-check --yes`.

## Manual check: a verifier checks a pull request, and the done rule

Tests use a fake Copilot, fake computers and a fake GitHub. This check uses the real GitHub and Docker and makes about 5 live Copilot calls: your message, the engineer, the verifier, and the coordinator's turn after each of them ends. Use the repo and project of the engineer check above (its steps 1 to 3).

1. Run `bun run computer:build`: verifiers need this image. On an older one a verifier ends **BLOCKED**, and its result asks you to rebuild the image.
2. In **Settings**, set `commands: { dev: "bun index.html", devUrl: "http://localhost:3000" }` and click **Save**.
3. Send: `Create a task "Add a home page": add index.html with a heading "Hello from Chiefbot". Dispatch an engineer on it, and have its pull request verified. If Chiefbot refuses to mark it done, leave it open.` Approve its push and its pull request.
4. The engineer's ending wakes the coordinator (`Engineer for task #<n> ended: opened <pull request URL>. …` in your chat), which dispatches a verifier. Under the task, **Verifier: starting its computer** shows, then `checkout: git fetch -q origin <sha> && git checkout -q --detach <sha> · exit 0`. While it works, click **Open**: its screen shows Chromium on `http://localhost:3000` with the heading. Also while it works, on github.com, edit index.html on the pull request's branch and commit: the verifier keeps checking the commit it was given. It ends **Verifier: finished**, and the task shows **Verified PASS @<short sha>** and **Report**. Click **Report**: **Context** opens `verify/task-<n>-<sha>-<id>.md` with the summary, the report and the screenshots.
5. Stale: the verifier's ending wakes the coordinator (`Verifier for task #<n> ended: PASS …`), which tries to mark the task done. It is refused (`… its PASS is for <sha>, and <url> has moved to <sha> since. Dispatch a verifier again. …`), and the task shows **Verified PASS @<sha> · stale**.
6. Done: click **Mark done** under the task. It shows **Done** and `Marked done in the app by <your login> · Verified PASS @<sha> · stale`. The engineer's and verifier's containers go, and the report and screenshots stay under **Context**.
7. Clean up as in the engineer check.

## Manual check: a chief's request ends in a verified PR

This check covers the six acceptance steps of the Projects spec (issue #57) in one run on a throwaway repo, then runs a verifier on a real web app. `apps/control/src/chiefToVerifiedPr.test.ts` runs the same loop offline, with a fake Copilot, fake computers and a fake GitHub. This check uses the real GitHub and Docker and one GitHub account on any Copilot plan. It makes 12 live Copilot calls, counted in each step: 9 on the throwaway repo and 3 on the real app. It is the spec's single end-to-end run, so it is an exception to the handful-per-ticket rule. It creates a repo, a branch and a draft pull request on your account: delete them at the end.

1. Create the throwaway repo with a page to change, and install your repo app on it:

   ```bash
   gh repo create chiefbot-e2e-check --private --add-readme --clone && cd chiefbot-e2e-check
   printf '<!doctype html>\n<title>Shop</title>\n<h1>Welcome to the shop</h1>\n' > index.html
   git add index.html && git commit -m "Add a home page" && git push && cd ..
   ```

   Run `bun run computer:build` (this code must be in the image), then control and the desktop apart (`bun run --cwd apps/control dev`, `bun run --cwd apps/desktop dev`). Sign in and pick a workspace. Your chief of staff is one of your bots (the **Chief of Staff** of your first sign-in, or a new one): wait until it is **online**.
2. No project file (1 call). Click **New project** and type `<your login>/chiefbot-e2e-check`. Within a minute the project opens with a **No project file** badge. Send `Where is the page heading rendered? Answer with file paths.` The turn shows **Fetch <your login>/chiefbot-e2e-check**, then a `repo_search` or `repo_read` call, and the reply names `index.html`. `docker ps` lists `chiefbot-project_…` and no `chiefbot-worker_…`.
3. Settings and a secret (no call). Click the gear. Under **Settings**, type these lines and click **Save**. Under **Secrets**, set `DEMO_TOKEN` to `demo-secret-value-1`. Close **Settings**.

   ```yaml
   commands:
     setup: test -n "$DEMO_TOKEN"
     dev: bun index.html
     devUrl: http://localhost:3000
   secrets: [DEMO_TOKEN]
   ```

4. A request and a follow-up, one task (3 calls). In the bot's chat send: `Hand the chiefbot-e2e-check project this: add a footer that says "Made with Chiefbot" to the home page. It is done when a verified pull request adds it. Tell it to wait for a follow-up before it starts an engineer, and to leave the task open if Chiefbot refuses to mark it done. Then send it the follow-up: the footer links to https://github.com, and it can start an engineer now.` The chat shows `send_to_project`, then `message_project`, and one card: **Accepted** and "Handed to chiefbot-e2e-check · task #1". Open the project. Your chat shows the request from your chief of staff, then "About task #1, from your chief of staff:" with the follow-up, each with the coordinator's reply. **Tasks** shows one task, #1, with an engineer under it.
5. The engineer sets up first and ends in a draft pull request (1 call). Under the task, the engineer shows `clone: git clone https://github.com/<your login>/chiefbot-e2e-check.git chiefbot-e2e-check · exit 0` and `setup: test -n "$DEMO_TOKEN" · exit 0`: its setup had the secret. **Open** shows the same two lines first in its transcript. The project's computer has no project secret: `docker exec chiefbot-project_<id> sh -c 'grep -l demo-secret-value-1 /proc/[0-9]*/environ 2>/dev/null | wc -l'` prints `0`. A **Push approval** card appears under the task, then a **Pull request approval** card: approve both. The task links the pull request, which is a **Draft** with the footer. The chief's card says **Pull request opened**.
6. The engineer's ending starts a fresh verifier on the pull request's head, with no message from you (2 calls). Your chat with the coordinator shows a system line, `Engineer for task #1 ended: opened <pull request URL>. Continue the task: …`, and the coordinator's turn dispatches a verifier. `docker ps -a` lists a second `chiefbot-worker_…`, and the engineer's is **Exited**. The verifier's setup shows `checkout: git fetch -q origin <sha> && git checkout -q --detach <sha> · exit 0`, with the head commit of the pull request (its **Commits** tab on github.com). While the verifier works, edit `index.html` on the pull request's branch on github.com and commit: the verifier keeps checking the commit it was given. Its screen (**Open**) shows Chromium on `http://localhost:3000` with the footer. It ends **Verifier: finished**. The task shows **Verified PASS @<short sha>** and **Report**, which opens the report and its screenshot in **Context**. The chief's card says **Verified** and **Verified PASS @<short sha>**.
7. The push makes the verdict stale (1 call). Your chat shows a second system line, `Verifier for task #1 ended: PASS for <pull request URL> at <short sha>: …`, and the coordinator tries to mark the task done. Control refuses (`… its PASS is for <sha>, and <url> has moved to <sha> since. Dispatch a verifier again. …`), and the coordinator leaves the task open, as asked. The task and the chief's card show **Verified PASS @<short sha> · stale**, and the card says **Pull request opened** again. If the coordinator dispatches a verifier anyway (1 more call), go on: step 9 removes it too.
8. A restart (1 call). Stop control (Ctrl-C) and quit the desktop, then start both again. The bot's chat shows one card for the handoff, where it was handed over, still **Pull request opened** with **Verified PASS @<short sha> · stale** and the pull request. Send the bot `How is the footer handoff going?` The chat shows `handoff_status`, and the reply names the pull request and the stale PASS at the same commit.
9. Deleting the project removes all of it (no call). The task is still open, so the engineer's and verifier's computers are still there. `docker ps -a --format '{{.Names}} {{.Status}}' | grep chiefbot-` lists the project's `chiefbot-project_…` and this check's two `chiefbot-worker_…`. Put their ids in `ids` and count what Docker has of them:

   ```bash
   ids='project_<id>|worker_<engineer id>|worker_<verifier id>'
   { docker ps -a --format '{{.Names}}'; docker volume ls -q; docker network ls --format '{{.Name}}'; } | grep -cE "$ids"
   ```

   It prints `9`: a container, a volume and a network each. Open the gear and click **Delete project**. Within a few seconds the same command prints `0`.
10. A verifier on a real web app (3 calls). Pick a repo your repo app is installed on: a web app with `commands.dev` and `devUrl`, and an open pull request with a small visible change (open one by hand if it has none). Create a project from it. In **Settings**, set what its project file does not (if it has one): its install command as `commands.setup`, `commands.dev`, `commands.devUrl`, and `secrets` with the names its dev server needs. Set their development values only: a verifier's screenshots are not masked. Send `Create a task "Check <pull request URL>" that links it, and dispatch a verifier on it. When the verifier ends, leave the task open and start nothing else.` The verifier's setup checks out the pull request's head and runs `commands.setup`. Its screen shows the app at `devUrl` with the change, and it ends with a verdict, a report and screenshots. The coordinator's turn after it starts nothing. Note what differs from the throwaway repo, such as a slow setup or a dev server that takes long to answer. Then delete the project.
11. Clean up: `gh repo delete <your login>/chiefbot-e2e-check --yes`, and close the real app's pull request if you opened it for this check.

## Manual check: watch an engineer and take control

Tests use a fake Copilot, fake computers and a fake screen. This check uses the real GitHub and Docker and makes 3 live Copilot calls (your message to the coordinator, the engineer, and the coordinator's turn after the engineer ends).

1. Set up as in the check "a project's engineer sets up, then ends in a draft pull request or a report", steps 1 and 2.
2. Send the coordinator the message of that check's step 4. The project's dot in the list pings while it works. In the panel's **Tasks** tab, click **Open** beside **Engineer: working**. The **Engineers** tab opens on that engineer: its screen, with **Watching | Take control** under it, and its transcript under that, live.
3. `docker ps` shows no published port for the `chiefbot-worker_…` container.
4. Click **Take control**. The screen gets a green ring and the pill says **You're in control | Stop**. Click **Terminal** in the dock and type: the text appears. The engineer's next tool call waits.
5. Click **Stop**. The transcript goes on. Optional, with a second member (the check "invite a second GitHub account to a workspace", steps 3 to 5, keeping both desktops open): open the same engineer in both and click **Take control** in one. The other shows **<login> is in control** with **Take control** greyed out, and its clicks do nothing. In the first, click the back arrow beside the engineer's title: the other's pill says **Watching** again.
6. When the **Push approval** card appears in the transcript and under the task, the project's dot turns amber and says **needs you**, and the **Projects** tab shows an amber dot while you are in **Bots**. Approve both cards as in that check. When the engineer shows **finished**, its screen gives way to a line saying it shows only while it works.
7. Open **Context**. If the coordinator wrote notes, they are listed; click one to read it.
8. Clean up as in that check's step 17.

## Manual check: a project listens to CI and an issue query

Tests use a fake MCP server, a fake clock and a fake Copilot. This check polls the real GitHub MCP server and makes about 3 live Copilot calls (one per event). It needs Docker, the computer image rebuilt with this code (`bun run computer:build`), and a repo with a GitHub Actions workflow you can make fail.

1. Create the project and save `connectors: [github, github-actions]` in its **Settings**. Add both presets on **Connectors** and connect a fine-grained personal access token with read access to the repo's actions, issues and metadata to each.
2. Open the project and click **Listening to**. Add **CI failures on a branch**: connector `github-actions`, branch `main`, every 1 min. Add **An issue query**: connector `github`, query `repo:<owner>/<repo> is:issue is:open label:chiefbot-test`, every 1 min. Add **A schedule**: "Post a one-line status note", cron two minutes from now, your timezone.
3. Within a minute both polls show "checked …" and "as <your login>", with no error. No task appears: the first poll only notes what is there.
4. Push a commit that makes the workflow fail on `main`. Within a minute of the run finishing, **Tasks** shows "CI failed on main: …" linking the run, and your chat shows the subscription's message about that task and the coordinator's reply.
5. Open an issue with the label `chiefbot-test`. Within a minute a task "Issue #…" appears with one message. Edit the issue's title: one more task appears. Nothing else repeats.
6. At the schedule's due time, a task "Scheduled: Post a one-line status note" and its message appear.
7. Restart control. After two more minutes the ledger has no duplicates. **Connector calls** lists `actions_list` and `search_issues` calls, as you, with the subscription's id as the run.
8. Clean up: remove the three subscriptions, delete the project, the issue and the failing commit, and revoke the token.

## Manual check: an organization pays for a project's coordinator

Needs a GitHub organization with Copilot Business or Enterprise whose policy allows Copilot requests from GitHub App installations, and an organization-owned repo with a README. Uses about two Copilot requests.

1. On a fresh `~/.chiefbot` (or a copy in `CHIEFBOT_HOME`), run `bun run setup --org <organization> --org-billed-copilot`. On github.com the repo app's page lists **Copilot Requests: Read and write** next to contents and pull requests. Install it on the organization with **All repositories**, as the printed step says, and tick Device Flow on the sign-in app.
2. Run `bun run computer:build`, then `bun run dev`, and sign in. Create a workspace and a project for the repo. Send the coordinator `Reply with one short sentence: who are you?`. The chat shows `On <your login>'s Copilot seat` above the reply.
3. On the **Members** screen, set **Copilot for projects** to **The organization**. Send the coordinator another message. The chat shows `Billed to <organization>'s Copilot (organization)` and a reply: the token worked. Note any error: `401` means the organization is not enabled for Copilot requests from GitHub App installations; `403` means the install is not on All repositories, or the token request lacks `repository_ids`.
4. Check the token cannot touch the repo. Find the coordinator's runtime: `docker exec chiefbot-<project id> sh -c 'for p in /proc/[0-9]*; do tr "\0" "\n" < $p/environ 2>/dev/null | grep ^COPILOT_GITHUB_TOKEN=; done | sort -u'`. With that token, `curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <token>" https://api.github.com/repos/<organization>/<repo>/contents/README.md` prints `404` (or `403`), never `200`.
5. On github.com, the organization's Copilot usage (Settings → Copilot → usage or the billing report) lists the requests under the app's installation within a day, not under your seat.
6. Renewal (optional, about an hour): leave the project idle for 45 minutes, then send another message. It is answered, and `docker exec chiefbot-<project id> ps -o pid,lstart,args | grep -i copilot` shows a runtime started just now. The earlier messages are still in the conversation: ask `What did I ask you first?`.
7. Mid-task renewal (optional, over an hour, a few Copilot requests): send the coordinator `Create a task "Long wait" and dispatch an engineer on it with these instructions: run "sleep 3600; echo finished" in the shell, then reply with its output.` About 55 minutes after the engineer starts, `docker exec chiefbot-worker_<id> ps -o lstart,args | grep -i copilot` shows a runtime started just now, and its transcript (**Engineers**, **Open**) shows it going on. It ends **finished**, not failed.
8. Clean up: delete the project and the workspace, and uninstall the repo app from the organization if it was only for this check.

## Manual check: production with docker compose

Checked locally on Colima with a fake GitHub (no Copilot calls): control in its container made a bot container through the Docker socket, the bot came online, a `wss://` socket and the connector OAuth callback worked through Caddy (its local certificate for `localhost`), and stop and delete removed the container and its volume. This check needs a Linux machine with a DNS name, and makes 2 to 3 live Copilot calls.

1. Follow `docs/deploy.md`, "Docker compose on one Linux machine", steps 1 to 4.
2. Run its smoke check, steps 1 to 7.
3. `docker compose down -v` and remove the DNS record when done.

## Manual check: invite a second GitHub account to a workspace

Tests use a fake GitHub with two users. This check uses the real GitHub with two accounts (the second can be a throwaway account) and makes no Copilot calls. It needs no Docker.

1. Run control and the desktop apart: `bun run --cwd apps/control dev` in one terminal, `bun run --cwd apps/desktop dev` in another. Sign in as your first account.
2. Open the **Projects** tab and the switcher at its top (it says **Personal**), type a name in **+ New workspace** and press Enter. The workspace becomes current and its **Members** screen lists you as **owner**.
3. Type the second account's login, in any letter case, and click **Invite**. It shows as invited, "joins once they sign in and accept".
4. Quit the desktop (control keeps running). Start one with its own sign-in: `bun run --cwd apps/desktop dev -- --user-data-dir=/tmp/chiefbot-second`, and sign in as the second account.
5. In this second desktop, the switcher shows a **1** badge. Open it and click **Accept**. The workspace becomes current, with you as **member** and a **Leave** button.
6. Click **Leave**. It goes back to **Personal**. Quit it and start the first desktop again (`bun run --cwd apps/desktop dev`): its **Members** screen lists only the owner.
7. Invite the second account again, accept as in steps 4 and 5, then click **Remove** next to it in the first desktop. In the second desktop, the workspace is gone from the switcher.
8. Removal ends what runs (optional; needs Docker, a project in the workspace as in the engineer check, and 2 Copilot calls): invite and accept once more. As the second account, ask the project's coordinator to create a task and dispatch an engineer on it, and keep the project's chat open. While the engineer shows **working**, remove the account in the first desktop. The second desktop's project chat closes, and within seconds `docker ps -a` no longer lists the engineer's container.
9. Clean up: `rm -rf /tmp/chiefbot-second`.

## Manual check: your own services on Health

Tests use a fake network. This check uses a local mock, and no Copilot call. It needs control and the desktop only.

1. Start the mock: `bun run mock:services`. It listens on `http://127.0.0.1:7471` (`MOCK_SERVICES_PORT`), and Auth's bearer token is `mock-token` (`MOCK_SERVICES_TOKEN`). Each of UI, Meta and Auth answers under `/prod`, `/preprod` and `/int`.
2. Run control and the desktop and sign in. Open **Health**: the **Services** card says **No services yet**.
3. Click **Add service**. Name it Meta and pick the database icon. Fill three environments, prod, preprod and int, each with `http://127.0.0.1:7471/<environment>/meta/actuator/health`. Click **Test** on prod: **Healthy**, `200 · UP · … ms`. Click **Add service**: Meta shows three healthy rows.
4. Add Auth with prod at `http://127.0.0.1:7471/prod/auth/actuator/health`, **Bearer token** `mock-token`, and preprod at `http://127.0.0.1:7471/preprod/auth/actuator/health` with the token `wrong`. **Test** says prod is **Healthy** and preprod is **Down**, "Answered 401: its credential was refused". Save: Auth is **Down**.
5. In a terminal, run `bun run mock:services set meta preprod down`, then `bun run mock:services set meta int slow`. `curl http://127.0.0.1:7471/_mock` lists every state. Click **Refresh**. Meta is **Down**: prod is healthy, preprod is down ("Answered 503 and reports DOWN") and int is slow ("Answered in 2.5 s, over the 2 s limit"). The headline says **Something is down**.
6. Click **Ask my bot** on Meta's preprod. Your last bot opens with a message naming Meta, preprod, the URL and the answer, ready to send. Don't send it.
7. Open Auth's ⋯ menu and click **Edit**. Each token shows as **Saved**, with **Replace**, never its value. Change preprod's URL to `http://localhost:7471/preprod/auth/actuator/health`: the dialog asks for the token again. Click **Cancel**.
8. Leave **Health** open for 6 minutes. The connections are checked again, and the services are not: their **Checked** time keeps growing.
9. Open Meta's ⋯ menu, click **Remove** and confirm. Meta leaves the card, with its secrets and checks.
10. Stop the mock with Ctrl+C.
