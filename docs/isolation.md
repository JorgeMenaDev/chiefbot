# Isolation between bots

Each bot is separate from every other bot, including other bots of the same user. A bot cannot read another bot's files, workspace, browser profile or credentials, cannot reach it over the network, and its worker can act only for its own bot on control.

## Boundaries now (Docker under Colima)

`DockerProvider` (`apps/control/src/computers/docker.ts`) gives every bot:

| Boundary | What it is | What it stops |
| --- | --- | --- |
| Disk | One named volume `chiefbot-<bot id>-home`, mounted at `/home/bot`. It holds the home, the workspace and the browser profile. It is the container's only mount. | Reading another bot's files. No host paths and no Docker socket are mounted. |
| Container | One container `chiefbot-<bot id>`, user `bot` (not root), all Linux capabilities dropped, `no-new-privileges`. | Getting root, mounting disks or changing the network from inside. |
| Network | One bridge network `chiefbot-<bot id>-net` per bot, with only that bot on it. | Reaching another bot by IP or by name. Docker drops traffic between bridge networks. |
| Credential | One bot token per bot, made by control and stored only as a hash. The computer gets it as `CHIEFBOT_BOT_TOKEN`, with `CHIEFBOT_BOT_ID`. | Acting for another bot. `/worker/:botId` answers 403 when the token belongs to another bot, and control's git proxy acts only for the owner of the bot the token belongs to. The token is not a GitHub token, and user session and GitHub tokens are refused (401). |

User routes (`/bots/:id/...`) check that the signed-in user owns the bot. Another user's bot reads as 404.

A project's task worker gets the same boundaries on its own throwaway computer (`chiefbot-worker_<id>`, with its own volume and network) and its own credential, `CHIEFBOT_TASK_WORKER_TOKEN`, valid only on `/task-worker/<its id>` and for control's git proxy. It acts for the member who asked for it: their GitHub access bounds what it may clone and push, and only they approve its pushes and pull requests. Proof: `taskWorkers.test.ts`.

Proof:

- `bun test` (fakes): `bots.test.ts` "a worker credential works only for its own bot", and `docker.test.ts` "each bot is locked down…".
- `CHIEFBOT_DOCKER_TESTS=1 bun test isolation.live` (real Docker, needs the image). It starts two bots and shows that bot A cannot read a file in bot B's home and cannot open bot B's port 8080 by IP or by name, while B reaches it. It also shows that A is not root, has no capabilities and has no Docker socket. If both bots are put on one shared network, the test fails.

### Known limits

- **One kernel.** All bots share the Colima VM's Linux kernel. A kernel exploit inside one container could reach the others. This is acceptable for a local proof of concept with one user's own bots.
- **The Mac is reachable.** Every bot reaches the Mac through `host.docker.internal`, because the worker dials control there. So a bot can also reach any other port the Mac listens on. Control's routes all need a token. Never publish a bot port on the Mac. The screen shows how: x11vnc listens only on the container's loopback, the worker dials control for each viewer, and control checks that the viewer owns the bot.
- **No resource limits.** A bot can use all of the VM's CPU and memory and slow the other bots down. Add limits when this shows up.
- **The root filesystem is writable.** Writes outside `/home/bot` stay in that bot's container and are lost when the container is removed.

## Repo access: approvals are a boundary in control

A bot asks before it pushes or opens a pull request (README, "Repo work and approvals"). The check runs in control, not in the bot's computer where the agent's shell runs:

| Route | What the bot computer has | What control does |
| --- | --- | --- |
| Fetch or clone | Git's remotes for github.com point at control's git proxy (`/git/<owner>/<repo>.git`, set by the worker through `GIT_CONFIG_*`). Git's credential helper hands it the bot's credential, which is not a GitHub token. | Checks that the owner is still signed in and, through a read-only installation token of the repo app for that one repo, that the owner can see it; then forwards with that token (anonymously for a public repo the app is not installed on). |
| Push (`git-receive-pack`) | The same credential. | Checks the owner may push and the app is installed. Holds the push, puts an approval card in the bot's running turn, and forwards exactly the bytes the owner approved with a one-repo installation token. No turn running, a decline, or a turn that ends first: GitHub never sees it. |
| Pull request | The `create_pull_request` tool, which calls `POST /worker/<bot id>/pull-requests` with the bot credential. | The same checks and approval, then opens it with an installation token. |

Control mints installation tokens with the repo app's private key (in control's `CHIEFBOT_HOME`, never in a bot computer), for one repo and only the permissions needed (`contents: read`, or `contents: write` and `pull_requests: write`), and they last an hour. It reads the owner's permission on the repo with the same token (`GET /repos/<repo>/collaborators/<login>/permission`): the owner's own token cannot, because it comes from the sign-in app, which sees no private repo. The bot computer has no credential helper for github.com, no `gh`, and no `GH_TOKEN` or `GITHUB_TOKEN`.

Proof: `repo.test.ts` (real git, the real worker, a fake GitHub that tells installation tokens from user tokens): the push waits in control and lands only after approval, pushed by the app; a decline or a push outside a turn never reaches GitHub; from the agent's shell `git credential fill`, a direct push past the proxy and the worker's socket yield no GitHub token; another account's repo, a read-only repo and a repo without the app are refused without a card; pull requests open only after approval; the GitHub token the bot computer gets can neither push nor open a pull request, where a user token of the repo app could. `docker.live` runs a clone through the proxy from a real container and shows a push outside a turn refused by control. `isolation.live` shows the image has no credential helper, `gh` or token.

### Two apps: sign-in and repos

`bun run setup` registers two GitHub Apps (README, Quickstart):

- **The repo app** has contents and pull requests write. Only control uses it, through the installation tokens above.
- **The sign-in app** has no repository permissions. The desktop signs in with it, so the owner's token in control's broker, the one a bot computer gets for the Copilot SDK, comes from it. GitHub limits a user token to its app's permissions, so this token reads the owner's profile and Copilot plan, and on repos nothing beyond what anyone may read on public ones: it cannot clone a private repo, push or open a pull request. Fallback: an OAuth App with only `read:user` (`bun run setup --oauth-client-id`), which can do no more.

A hostile agent can still get that token: every process in the computer runs as user `bot`, so the shell can read the bot credential from `/proc/1/environ` (checked in a real container) and ask the broker (`/worker/<bot id>/github-token`), or find the token in the runtime. With it, the agent still cannot reach a repo without control.

Proof: `repo.test.ts` "the GitHub token a bot computer gets can neither push nor open pull requests…", against a fake GitHub that, like GitHub, limits each user token to the permissions of the app that issued it. The README's manual check "the sign-in token cannot write, and drives Copilot" shows it on the real GitHub.

### What remains

- **The sign-in token spends the owner's Copilot plan.** A hostile agent that takes it can make Copilot requests on the owner's plan, and read their profile, until it expires (8 hours at most; **Disconnect GitHub** stops new ones, and revoking the sign-in app at github.com/settings/apps/authorizations ends the current one).
- **Unverified: a GitHub App with no permissions driving Copilot.** GitHub's Copilot SDK docs say GitHub App user tokens (`ghu_`) and OAuth App tokens (`gho_`) both work for user-billed sessions, but not whether the app needs any permission. The README manual check settles it. If the sign-in app's token cannot run Copilot, the OAuth App fallback (`read:user`) is the one known to work.
- **GitHub tools in the runtime.** The Copilot runtime's built-in GitHub tools act with the sign-in token, so they cannot write to repos either. The worker still asks before one that writes, as a guardrail against mistakes.
- **The bot credential is readable in the computer** (above). It is not a GitHub token: through control it reaches only the routes above, each checked against the owner's access and approval, plus the broker.

## What changes on GCP (one VM per bot, ticket #10)

| Boundary | Docker now | GCP |
| --- | --- | --- |
| Compute | Container on a shared kernel | One Compute Engine VM per bot, with its own kernel. The shared-kernel limit goes away. |
| Disk | Named volume | One persistent disk per bot, attached only to that bot's VM. |
| Network | One bridge network per bot | VPC firewall rules (`infra/gcp`): ingress only from IAP (SSH), so bot VMs cannot reach each other; egress through Cloud NAT, no external IP. Bot VMs may open only control's port. The "Mac is reachable" limit becomes "control is reachable", and only control. |
| Credential | Bot token in the container env | The same bot token, delivered in the VM's instance metadata (cloud-init) and handed to the container as env. Project members who can read VMs can read it; Secret Manager is a later step. Control's checks do not change. |
| Cloud identity | None | The VM's service account `chiefbot-computer` can only pull the image and write logs. The bot container cannot use it: a firewall rule on the VM drops the container's traffic to the metadata server. |
| Resource limits | None | The machine type sets them per bot. |

The worker, the bot token and control's checks are the same in both places. Only the `ComputerProvider` changes.
