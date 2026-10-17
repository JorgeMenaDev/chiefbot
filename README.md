# Chiefbot

Personal chief-of-staff bots, each with its own computer, powered by the GitHub Copilot SDK on your own Copilot plan.

Status: proof of concept. It runs locally, with bot computers as Docker containers. The GCP deploy (one Compute Engine VM per bot) is written but not deployed: `infra/gcp` and the runbook `docs/deploy-gcp.md`. Licence: MIT (`LICENSE`). Contributing: `CONTRIBUTING.md`. Architecture: `AGENTS.md`.

## Quickstart

You need a Mac, [Bun](https://bun.sh) 1.4 or later, Docker (Docker Desktop, OrbStack or Colima, running) and a GitHub account. Chats need GitHub Copilot on that account; Copilot Free works.

```bash
git clone https://github.com/JorgeMenaDev/chiefbot.git && cd chiefbot
bun install
bun run setup           # registers your own GitHub App, then two clicks on github.com (below)
bun run computer:build  # builds the bot computer image chiefbot-computer:dev
bun run dev             # control on http://127.0.0.1:7410 and the desktop app
```

`bun run setup` opens github.com with a ready-made GitHub App (GitHub's App Manifest flow). Click **Create GitHub App** and it returns to setup, which saves the app in `~/.chiefbot/` (folder 700, files 600, outside the repo): `config.json` with the app's ID and client ID, and `github-app-secrets.json` with its client secret and private key. Setup then prints two links:

1. The app's settings: tick **Enable Device Flow** and click **Save changes**. A manifest cannot set it, and the desktop signs in with it.
2. The app's install page: install it on the repositories your bots may work on. A bot's token reaches only those.

The app asks for repository contents (write) and pull requests (write), and for nothing else. To own the app in an organization, run `bun run setup --org <organization>`. To start over, delete the app on github.com and `~/.chiefbot/config.json`, then run setup again. Without a config, control and the desktop stop with "Run `bun run setup`".

In the desktop app, click **Sign in with GitHub**, then **+ New bot**.

Timing, measured on a fresh clone on an Apple-silicon Mac: `bun install` with an empty Bun cache took 5 s and `bun run computer:build` 69 s with the `oven/bun` base image already pulled (allow about 2 minutes without it). Setup is about a minute of clicking on github.com.

Other commands: `bun run check` (typecheck, tests and the public-repo check; no network, Docker or GCP). `CHIEFBOT_COMPUTER_IMAGE` names another image tag.

## How it works

Creating a bot needs Docker and the `chiefbot-computer:dev` image. Each bot is a container `chiefbot-<bot id>` on its own network `chiefbot-<bot id>-net`, with a volume `chiefbot-<bot id>-home` mounted at `/home/bot` (its home and workspace). Its worker dials control's `/worker/<bot id>` WebSocket with a per-bot credential and the bot shows **online**. Bots cannot see each other: `docs/isolation.md`.

`CHIEFBOT_DOCKER_TESTS=1 bun test docker.live` runs the whole loop on real Docker (needs the image). `CHIEFBOT_DOCKER_TESTS=1 bun test isolation.live` shows two bots cannot read each other's volume or reach each other over the network. Both use `CHIEFBOT_COMPUTER_IMAGE` if set and remove what they create.

**Chat.** A message to a bot goes to control, which stores it and forwards it to the bot's worker. The worker runs the turn on the Copilot SDK (`@github/copilot-sdk`, pinned exactly in `apps/worker/package.json`) in `copilot-cli` mode, working in `/home/bot/workspace`. The bot has one conversation; the SDK keeps it under `/home/bot/.copilot`, so it resumes after the computer restarts. The SDK gets the user's GitHub access token from control's broker (`GET /worker/<bot id>/github-token`) through `gitHubTokenProvider`. Reply text, tool calls and status stream back to the desktop and are stored in control, so history survives a restart of any process. The image carries the SDK's bundled Linux runtime (about 170 MB of the image).

**Tokens.** The desktop signs in with your GitHub App's device flow, so its tokens (`ghu_…`) carry the app's permissions on the repositories it is installed on. The broker hands a bot only its owner's access token, with more than two hours left, never the refresh token. When less is left it refreshes with GitHub's refresh grant (device-flow tokens need no client secret), one refresh at a time per user: a refresh invalidates the old pair, so concurrent requests share it. The refresh token sits in a `SecretStore`: locally encrypted (AES-256-GCM) in control's SQLite under the key in `CHIEFBOT_SECRET_KEY_FILE`; on GCP in Secret Manager. When GitHub refuses the refresh token (expired after 6 months unused, or the app's authorization was revoked on github.com), or the user clicks **Disconnect GitHub**, control forgets the sign-in: bots get a typed `reauth_needed` refusal, their turns end with "Sign in again", and the desktop shows a **Sign in again** notice. Disconnect does not revoke the app at GitHub: an access token already handed out works until it expires, at most 8 hours, unless you revoke the app's authorization at github.com/settings/apps/authorizations.

**Model per bot.** Each bot has its own Copilot model, chosen in the composer's model picker. Once a bot's worker connects, it lists the models the owner's Copilot plan offers on the bot's SDK session and reports them to control. Control keeps the latest list per user in SQLite (`GET /models`). Picking a model saves it on the bot (`PUT /bots/:id/model`). Every turn carries the bot's model, and the worker switches the session before the turn, so the conversation is kept. On Copilot Free only Auto can be picked: the SDK accepts a switch but every turn still runs on Auto, so the other models in Copilot's catalog show as locked rows with "Needs a paid Copilot plan". On a paid plan, models a Copilot policy turns off show locked too.

**Routines.** A routine is a prompt plus a schedule: a cron expression (5 fields, or 6 with seconds) read in an IANA timezone, parsed by `croner`. Open **Routines** on a bot to add, edit or delete them. Control runs them whether or not the desktop is open: at the due time it starts the bot's computer if it is stopped, waits up to 5 minutes for the worker, sends the prompt as a chat turn (30 minutes at most) and stops the computer again if the run started it. The reply lands in the bot's chat, and the routine shows its last run: succeeded, failed (with the reason, such as a lost GitHub sign-in) or skipped (the bot was busy, or someone had taken over its screen; no retry). A bot runs one routine at a time. Each (routine, due time) runs at most once, even across control restarts: a run cut short by a restart is marked failed and its computer stopped again, and due times missed while control was down run once when it is back.

**Idle stop.** Control stops a bot's computer after 30 minutes (`CHIEFBOT_IDLE_STOP_MINUTES`) with no running turn, no pending approval, no screen viewer and no routine run in progress, with Docker and on GCP alike. **Start** in the app or a due routine starts it again.

**Repo work and approvals.** A bot clones, branches, edits and commits in its workspace without asking. Before it pushes or opens a pull request, it asks you: the chat shows an approval card (after T3 Code's) with the exact command or pull request, and the bot waits until you click **Approve** or **Decline**, however long that takes. The worker's permission handler decides what asks (`apps/worker/src/approvals.ts`): shell commands that mention `git … push`, `gh pr create|merge`, `gh repo delete`, a `gh api` write to `/pulls` or a way to skip git hooks, the bot's `create_pull_request` tool, and GitHub tools that write. Every push also asks through git's pre-push hook, however the command was spelled, unless it is the push command you just approved. Approvals guard against model mistakes, not a hostile bot: `docs/isolation.md`. Control stores each request and answer (`POST /bots/<id>/approvals/<approval id>`), so a pending card survives a restart of the desktop or control and you can answer later; if the bot's computer restarts first, the turn ends and the card shows **Expired**. A routine's turn waits for approvals the same way: if its 30-minute limit passes first, the run is marked failed, but the card stays answerable and the bot's computer stays running until the turn ends. Git gets the owner's token from control's broker on each use: the image configures a credential helper for github.com that asks the worker over a unix socket (`apps/worker/src/gitCredential.ts`), so no token is written to the bot's disk or into a remote URL. Pull requests go through the GitHub API from the worker (`CHIEFBOT_GITHUB_API_URL`, passed on by control). The token reaches only repositories where your GitHub App is installed.

**Workspaces.** A workspace is a team. Anyone signed in can create one and is its owner. The owner invites people by GitHub login; an invite waits until someone with that login signs in to Chiefbot and accepts it from the workspace switcher at the top of the sidebar. The **Members** screen lists members and pending invites: the owner invites, withdraws invites and removes members, and a member can leave. There are two roles, owner and member, and the owner cannot leave. Every workspace route answers 404 to anyone who is not a member, so outsiders cannot tell a workspace exists. Projects belong to a workspace, and connectors will too; bots stay personal.

**Projects.** A project binds one GitHub repo to a workspace. Any member creates one from the sidebar (**+ New project**, `owner/repo`). Control reads the repo's `chiefbot.project.yaml` from its default branch through the GitHub API with that member's token, so your GitHub App must be installed on the repo. The file is checked with a Zod schema (`ProjectFile` in `packages/contracts/src/projects.ts`); unknown keys are errors, and a missing or invalid file is refused with what is wrong and where:

```yaml
connectors: [github, jira]   # the connectors (MCP servers) its agents need, by name
environments:                # where its workers run; image defaults to the bot computer image
  - name: web
commands:
  build: bun run build
  test: bun test
```

Each project gets one computer from the `ComputerProvider` (`chiefbot-<project id>`), which runs the project's **coordinator** instead of a bot worker. The coordinator plans and tracks work and never writes code: it runs the Copilot SDK in `mode: "empty"` (no shell, no files, no ambient config) with five tools only, all served by control: `create_task`, `update_task`, `list_tasks`, `read_context` and `write_context`. The **task ledger** in control's SQLite is the only record of task state (open, in progress, needs input, done, abandoned; an owner, who asked, and links to pull requests, context files or pages). **Shared context** is a set of Markdown files every agent of the project reads and adds to (`notes.md`, `docs/`, `plans/`), kept by control in a `ContextStore`: a `context` folder next to the database now, a bucket later. Each member has their own chat with the coordinator, which runs on that member's Copilot seat: control brokers a token only for the member whose turn is running. One scheduler per project runs the coordinator's turns one at a time across all members' chats, oldest first, so each turn sees the tasks the turns before it made, and two members asking for the same thing get one task. The desktop shows the ledger beside the chat and updates it live. Workers that carry out tasks come next.

If `bun run dev` fails with `Electron uninstall`, the Electron binary was not downloaded: run `node apps/desktop/node_modules/electron/install.js`.

`bun run dev` starts both apps. To run them apart: `bun run --cwd apps/control dev` and `bun run --cwd apps/desktop dev`.

The desktop dev script unsets `ELECTRON_RUN_AS_NODE`. Shells started by T3 Code or other Electron apps set it, and it makes Electron run as plain Node.

## Configuration

| Variable | App | Default |
| --- | --- | --- |
| `CHIEFBOT_CONTROL_PORT` | control | `7410` |
| `CHIEFBOT_CONTROL_HOSTNAME` | control | `127.0.0.1` (`0.0.0.0` on the GCP control VM) |
| `CHIEFBOT_DB_PATH` | control | `.data/control.sqlite` (in `apps/control`) |
| `CHIEFBOT_GITHUB_API_URL` | control | `https://api.github.com` |
| `CHIEFBOT_GITHUB_URL` | control | `https://github.com` (the refresh grant) |
| `CHIEFBOT_GITHUB_CLIENT_ID` | control | The client ID in `~/.chiefbot/config.json` (`bun run setup`). Must match the desktop's, or refreshes fail. The GCP control VM sets it from Terraform |
| `CHIEFBOT_HOME` | setup, control, desktop | `~/.chiefbot`: setup's config and secrets, and the default secret key |
| `CHIEFBOT_SECRET_KEY_FILE` | control | `~/.chiefbot/secret.key`: the key that encrypts refresh tokens, made (mode 600) on first run. Keep it outside the repo. Losing it means signing in again. Not used with `gce` (Secret Manager) |
| `CHIEFBOT_DOCKER_SOCKET` | control | `DOCKER_HOST`'s unix socket, else `~/.colima/default/docker.sock` if it exists, else `/var/run/docker.sock` |
| `CHIEFBOT_COMPUTERS` | control | `docker`; `gce` runs bots as Compute Engine VMs |
| `CHIEFBOT_COMPUTER_IMAGE` | control | `chiefbot-computer:dev` for docker; required for gce |
| `CHIEFBOT_GCP_PROJECT` | control (gce) | required |
| `CHIEFBOT_GCP_ZONE` | control (gce) | `europe-west2-a` (London) |
| `CHIEFBOT_WORKER_CONTROL_URL` | control | `http://host.docker.internal:<port>` (control as a container reaches it) |
| `CHIEFBOT_IDLE_STOP_MINUTES` | control | `30`: a bot's computer stops after this long with no running turn, no pending approval, no screen viewer and no routine run |
| `CHIEFBOT_CONTROL_URL` | desktop | `http://127.0.0.1:7410` |
| `CHIEFBOT_GITHUB_URL` | desktop | `https://github.com` |
| `CHIEFBOT_GITHUB_CLIENT_ID` | desktop | The client ID in `~/.chiefbot/config.json` (`bun run setup`): device flow, no secret, 8-hour tokens |
| `CHIEFBOT_GITHUB_URL`, `CHIEFBOT_GITHUB_API_URL` | setup | `https://github.com`, `https://api.github.com` |

## Manual check: `bun run setup` on the real GitHub

Tests run setup against a fake GitHub. This check registers a real GitHub App on your account and makes no Copilot calls. Time it.

1. On a fresh clone, run `bun install`, then `bun run setup`. A browser tab opens on github.com's **Create GitHub App** page with the name `Chiefbot <6 hex digits>` filled in. If the name is taken, change it.
2. Click **Create GitHub App**. The tab returns to `127.0.0.1` and says **Your Chiefbot GitHub App is registered**. The terminal prints the same two links.
3. `ls -la ~/.chiefbot` shows the folder as `drwx------` and `config.json` and `github-app-secrets.json` as `-rw-------`. `git status` in the clone shows nothing new.
4. Open the first link, tick **Enable Device Flow**, click **Save changes**. Open the second link and install the app on one repository.
5. Run `bun run setup` again. It refuses: "already set up with the GitHub App …".
6. Run `bun run computer:build` and `bun run dev`, then do the next check (sign-in). If the window says **Your GitHub App has Device Flow off**, step 4's box is not saved.
7. If sign-in fails with `copilot_internal/user failed`, GitHub refuses that read for GitHub App tokens: note the status code for the Copilot ticket.
8. Write down the minutes from step 1 to a signed-in window.

## Manual check: real GitHub sign-in

Tests use a fake GitHub. This check uses the real one and makes no Copilot chat calls.

1. Run `bun run dev`.
2. In the Chiefbot window, click **Sign in with GitHub**. The window shows a code.
3. Click the link, sign in on github.com/login/device, type the code and approve.
4. Within a few seconds the window shows your login and your Copilot plan (for Copilot Free: `individual (free_limited_copilot)`).
5. Quit and start `bun run dev` again. You are still signed in.
6. Click **Sign out**. The window goes back to **Sign in with GitHub**.

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
4. Click **Disconnect GitHub** in the sidebar. The **Sign in again** notice appears. `broker` answers `{"error":"reauth_needed"} 403`.
5. Click **Sign in again** and finish the device flow. The notice goes away and `broker` answers `200`.
6. Revoke your Chiefbot app at github.com/settings/apps/authorizations, then repeat step 3. `broker` answers `403` and the notice appears without a reload.
7. Clean up: delete the bot with **Also delete its files**, then `docker rmi chiefbot-computer:dev`.

## Manual check: a bot gets its own computer

Needs Docker running. Makes no Copilot calls.

1. Run `bun run computer:build`, then `bun run dev`, and sign in.
2. Click **+ New bot**, type a name and press Enter. The bot appears in the sidebar and turns green (**online**) within a few seconds.
3. `docker ps` shows `chiefbot-bot_…` running. `docker logs <name>` says `worker connected to http://host.docker.internal:7410 as bot_…`.
4. Click **Stop**. The bot shows **stopped** and the container has exited. Click **Start**. It comes back **online**.
5. Restart control (save a file in `apps/control`). The bot goes back **online** without a click.
6. Click **Delete**, tick **Also delete its files** and confirm. The bot leaves the sidebar, and `docker ps -a`, `docker volume ls` and `docker network ls` show nothing for it. Without the tick, the volume `chiefbot-<bot id>-home` stays: remove it with `docker volume rm`.
7. Clean up: `docker rmi chiefbot-computer:dev`.

## Manual check: watch and take over a bot's screen

Needs Docker running. Makes no Copilot calls.

1. Run `bun run computer:build`, then `bun run dev`, sign in and create a bot.
2. When the bot is **online**, the side pane shows its screen: Chromium on a 1280×800 desktop. The pane says **Watching. The bot drives.** Clicks and keys in the pane do nothing.
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
2. Click **Routines**, then **+ New routine**. Prompt: `Reply with one short sentence: what time is it where you are?`. Cron: two minutes from now, for example `32 14 * * *` at 14:30. Timezone: yours (filled in). Click **Save**. The row shows the next run time in your local time.
3. Quit the desktop app.
4. Wait a few minutes past the due time. `docker ps -a` shows the bot's container exited again.
5. Start the desktop app and open the bot. The chat shows the prompt and the reply, and **Routines** shows `Last run …: succeeded`.
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
2. Install your GitHub App on `chiefbot-scratch` (the install link `bun run setup` printed, or github.com/settings/installations). Run `bun run computer:build`, then `bun run dev`, and sign in.
3. Pick a bot (or create one) and wait until it is **online**.
4. Send: `Clone https://github.com/<your login>/chiefbot-scratch, create a branch chiefbot-check, add the line "Hello from Chiefbot" to README.md, commit, push the branch and open a pull request into main with the create_pull_request tool.`
5. The clone and the commit run without a card. Then a **Command approval** card shows the `git push` command, and the status line says **Waiting for your approval**. On github.com the repo has no `chiefbot-check` branch yet.
6. Quit the desktop app and start it again. The card is still there and still pending. Click **Approve**. The push runs, and the branch appears on github.com.
7. A **Pull request approval** card shows `<your login>/chiefbot-scratch: chiefbot-check → main` and the title. Click **Approve**. The bot replies with the pull request's URL. Open it: it has the README change.
8. Check that the token is not on the bot's disk: `docker exec chiefbot-<bot id> sh -c 'grep -rlE "gh[ou]_" /home/bot /tmp; git -C /home/bot/workspace/chiefbot-scratch remote get-url origin'` prints only `https://github.com/<your login>/chiefbot-scratch` (no file names, no token in the URL).
9. Send: `Add a second line to README.md, commit and push.` Click **Decline** on the card. The bot says the push was declined, and github.com shows no new commit.
10. If a card turns **Expired** while the bot was still running, the Copilot runtime gave up waiting: note how long it waited. If git says `lost your GitHub sign-in`, control needs a new sign-in: click **Sign in again**. If the push fails with 403, your GitHub App is not installed on the repo.
11. Clean up: `gh repo delete <your login>/chiefbot-scratch --yes` (it removes the pull request too).

## Manual check: two members ask a project's coordinator for the same thing

Tests use a fake Copilot. This check makes 3 live Copilot calls on the real GitHub with two accounts in one workspace (as in the workspace check below). It needs Docker and the computer image rebuilt with this code (`bun run computer:build`).

1. In a repo your GitHub App is installed on, commit a `chiefbot.project.yaml` at the root with `commands: { test: bun test }`. In a second repo, commit one with a typo: `conectors: [github]`.
2. Run control and the desktop apart (`bun run --cwd apps/control dev`, `bun run --cwd apps/desktop dev`) and sign in as the workspace owner. Pick the workspace in the switcher.
3. Click **+ New project** and type the second repo as `owner/repo`. The form shows `invalid_project_file` with `Unrecognized key: "conectors"`, and no project appears.
4. Create a project from the first repo. It opens with its build and test commands under its name, an empty chat and **Tasks: 0 open**.
5. Send: "We need a dark mode toggle in settings. Track it as a task." The reply comes back and the task appears under **Tasks** as #1, asked by you.
6. Start a second desktop as the member (`bun run --cwd apps/desktop dev -- --user-data-dir=/tmp/chiefbot-second`), open the project and send: "Can we get dark mode in the settings page?" The coordinator answers that task #1 already covers it. The ledger still shows one task in both desktops.
7. In the second desktop send: "Mark the dark mode task as in progress." Both desktops show #1 **In progress** without a reload.
8. In the second desktop the project has no **Delete** button: only the owner deletes. In the first desktop click **Delete** and confirm. The project leaves the sidebar and `docker ps -a` no longer lists `chiefbot-project_…`. Clean up: `rm -rf /tmp/chiefbot-second`.

## Manual check: invite a second GitHub account to a workspace

Tests use a fake GitHub with two users. This check uses the real GitHub with two accounts (the second can be a throwaway account) and makes no Copilot calls. It needs no Docker.

1. Run control and the desktop apart: `bun run --cwd apps/control dev` in one terminal, `bun run --cwd apps/desktop dev` in another. Sign in as your first account.
2. Open the switcher at the top of the sidebar (it says **Personal**), type a name in **+ New workspace** and press Enter. The workspace becomes current and its **Members** screen lists you as **owner**.
3. Type the second account's login, in any letter case, and click **Invite**. It shows as invited, "joins once they sign in and accept".
4. Quit the desktop (control keeps running). Start one with its own sign-in: `bun run --cwd apps/desktop dev -- --user-data-dir=/tmp/chiefbot-second`, and sign in as the second account.
5. In this second desktop, the switcher shows a **1** badge. Open it and click **Accept**. The workspace becomes current, with you as **member** and a **Leave** button.
6. Click **Leave**. It goes back to **Personal**. Quit it and start the first desktop again (`bun run --cwd apps/desktop dev`): its **Members** screen lists only the owner.
7. Invite the second account again, accept as in steps 4 and 5, then click **Remove** next to it in the first desktop. In the second desktop, the workspace is gone from the switcher.
8. Clean up: `rm -rf /tmp/chiefbot-second`.
