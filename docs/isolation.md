# Isolation between bots

Each bot is separate from every other bot, including other bots of the same user. A bot cannot read another bot's files, workspace, browser profile or credentials, cannot reach it over the network, and its worker can act only for its own bot on control.

## Boundaries now (Docker under Colima)

`DockerProvider` (`apps/control/src/computers/docker.ts`) gives every bot:

| Boundary | What it is | What it stops |
| --- | --- | --- |
| Disk | One named volume `chiefbot-<bot id>-home`, mounted at `/home/bot`. It holds the home, the workspace and the browser profile. It is the container's only mount. | Reading another bot's files. No host paths and no Docker socket are mounted. |
| Container | One container `chiefbot-<bot id>`, user `bot` (not root), all Linux capabilities dropped, `no-new-privileges`. | Getting root, mounting disks or changing the network from inside. |
| Network | One bridge network `chiefbot-<bot id>-net` per bot, with only that bot on it. | Reaching another bot by IP or by name. Docker drops traffic between bridge networks. |
| Credential | One bot token per bot, made by control and stored only as a hash. The computer gets it as `CHIEFBOT_BOT_TOKEN`, with `CHIEFBOT_BOT_ID`. | Acting for another bot. `/worker/:botId` answers 403 when the token belongs to another bot. The token is not a GitHub token, and user session and GitHub tokens are refused (401). |

User routes (`/bots/:id/...`) check that the signed-in user owns the bot. Another user's bot reads as 404.

Proof:

- `bun test` (fakes): `bots.test.ts` "a worker credential works only for its own bot", and `docker.test.ts` "each bot is locked down…".
- `CHIEFBOT_DOCKER_TESTS=1 bun test isolation.live` (real Docker, needs the image). It starts two bots and shows that bot A cannot read a file in bot B's home and cannot open bot B's port 8080 by IP or by name, while B reaches it. It also shows that A is not root, has no capabilities and has no Docker socket. If both bots are put on one shared network, the test fails.

### Known limits

- **One kernel.** All bots share the Colima VM's Linux kernel. A kernel exploit inside one container could reach the others. This is acceptable for a local proof of concept with one user's own bots.
- **The Mac is reachable.** Every bot reaches the Mac through `host.docker.internal`, because the worker dials control there. So a bot can also reach any other port the Mac listens on. Control's routes all need a token. Never publish a bot port on the Mac. The screen shows how: x11vnc listens only on the container's loopback, the worker dials control for each viewer, and control checks that the viewer owns the bot.
- **No resource limits.** A bot can use all of the VM's CPU and memory and slow the other bots down. Add limits when this shows up.
- **The root filesystem is writable.** Writes outside `/home/bot` stay in that bot's container and are lost when the container is removed.

## Approvals are a guardrail against model mistakes, not an adversarial boundary

A bot asks before it pushes or opens a pull request (README, "Repo work and approvals"). Three layers make that hold however the model spells the command:

- **Every push asks at the git level.** The image's system gitconfig (root-owned) sets `core.hooksPath` to `/opt/chiefbot/hooks`, whose `pre-push` asks the worker, which asks the user in the chat (`apps/worker/src/prePush.ts`). A push the user already approved as a command passes without a second card.
- **The shell matcher asks early** (`apps/worker/src/approvals.ts`). It reads the command with quotes and backslashes removed and also asks for `--no-verify`, `core.hooksPath` overrides, `GIT_CONFIG_*` variables and `gh api` writes to `/pulls`.
- **gh has no token.** gh is not installed, and the agent's shell gets no `GH_TOKEN`, `GITHUB_TOKEN` or bot credential (`agentEnv` in `apps/worker/src/copilotSdk.ts`). A pull request needs the approval-gated `create_pull_request` tool.

A model that tries to get around these still can. The git credential helper hands the owner's token to any process in the computer that asks (`git credential fill`), and the bot can write its own hooks path into a repo's config with a command the matcher does not recognise. So approvals stop mistakes, not a bot that works against its user.

The real fix, for later: a git proxy in control. The bot computer would push and open pull requests only through control, which asks the user and then uses a separate repo credential that never enters the bot computer.

Proof: `approvals.test.ts` (each spelling the review found), `repo.test.ts` "a push the shell matcher cannot see still asks the user, through git's pre-push hook", `copilotSdk.test.ts`, and `isolation.live` (the image's hook refuses a push when nobody can approve it, and gh and its tokens are absent).

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
