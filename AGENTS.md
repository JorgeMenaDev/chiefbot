# Chiefbot

A desktop app where each bot is a "chief of staff" with its own computer. Each bot clones repos, runs commands and opens pull requests. Every agent runs on the GitHub Copilot SDK (`@github/copilot-sdk`) and uses the signed-in user's own Copilot plan. Each bot has its own model.

Spec (v0.2, teams and projects): https://github.com/JorgeMenaDev/chiefbot/issues/13. Chiefbot is open source (MIT) and generic: each deployer brings their own GitHub Apps (`bun run setup`).

## Architecture

```
apps/desktop  Electron + React + Vite. GitHub device-flow sign-in, bot sidebar, chat, model picker, bot details panel with the live screen (noVNC).
apps/control  Control plane: Node/TS HTTP + WebSocket, SQLite. Users, bots, runs, schedules, token broker, ComputerProvider.
apps/worker   Runs inside each bot computer. Dials out to control, runs Copilot SDK sessions (copilot-cli mode).
packages/contracts  Zod schemas for every message that crosses a process boundary. Types are inferred from them.
packages/setup      `bun run setup`: registers the deployer's own repo app and sign-in app (App Manifest flow) and writes ~/.chiefbot. Control and desktop read the sign-in app's client ID; control alone uses the repo app.
packages/fake-github  The fake GitHub every test uses.
infra/        Computer and control Docker images (built from the repo root), Caddy for compose.yaml, Terraform for GCP (written, NOT applied until the deployer approves the spend). docs/deploy.md.
templates/    The template catalog: one folder per kind of service stack an engineer can get (templates/<name>/README.md). Not wired into control yet. Its checks need Docker, so `bun run check` leaves them out.
```

- **Bot computer** = one Docker image (Xvfb + a desktop whose dock opens Chromium, Files and Terminal + x11vnc on loopback + xdotool and scrot for the agent's `computer` tool + git + worker) with one volume per bot. It runs locally under Docker now and on GCP later, one Compute Engine VM per bot. Both sit behind one `ComputerProvider` interface (`create / start / stop / destroy / status`): `DockerProvider` (local) and `GceProvider` (GCP). The screen opens no port: for each viewer the worker dials control and pipes x11vnc, and control checks the viewer owns the bot.
- **Tokens:** the desktop does device-flow sign-in with the deployer's sign-in app (no repository permissions; or an OAuth App with only `read:user`), then hands the tokens to control. The refresh token never leaves control. Workers fetch short-lived access tokens from control's broker through the SDK's `gitHubTokenProvider`. Repo writes go only through control: its git proxy and pull request route ask the owner first, then use the repo app's installation tokens, which never reach a bot computer. The sign-in token a bot computer gets cannot write to any repo (`docs/isolation.md`).
- **Durable state lives in control,** never only in a bot computer. Bots keep working when the desktop app is closed.
- **Multi-user data model** from day one: every row is owned by a `UserId`.

## Rules

- TypeScript strict, no `any`, no casting wrappers. Zod schemas in `packages/contracts` are the source of types. Infer them, don't restate them.
- Keep it simple (YAGNI). No abstraction until a second caller exists. `ComputerProvider` is the one planned seam.
- Build each ticket test-first (`tdd`). Tests are focused, with no smoke-test sprawl. Tests use fakes for Copilot, Docker and GCP, so `bun test` needs no network, Docker or tokens.
- **No GCP spend.** Never run `terraform apply` or create any cloud resource. GCP code is tested with fakes only.
- **Docker cleanup:** remove only the objects you created, by ID. Remove images with `docker rmi --no-prune <id>`. Never run `docker system/image/builder prune`: it deletes the owner's build cache.
- **Copilot Free has 200 chats/month.** Live Copilot calls happen only in explicitly named manual checks, at most a handful per ticket.
- Never print or commit tokens. `.env*` is git-ignored. The repo app's secrets live in `~/.chiefbot/` (owner-only), never in the repo.
- Generic code only: no personal or company names, client IDs or private links. `scripts/check-public.sh` (in `bun run check`) fails on them; test fixtures use logins like `octo-user`.
- T3 Code (https://github.com/pingdotgg/t3code, MIT, local clone `~/.btca/agent/sandbox/t3code`) is the UX and architecture reference. Ported code keeps T3's MIT notice in `THIRD_PARTY_NOTICES.md`.
- Commands: `bun install`, `bun run setup` (once per machine), `bun run check` (typecheck + tests + `check-public`). CI runs the same check.
- Conventional commits: `feat(control): …`, `fix(desktop): …`.
