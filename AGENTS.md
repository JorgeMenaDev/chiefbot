# Chiefbot

A desktop app where each bot is a "chief of staff" with its own computer. Each bot clones repos, runs commands and opens pull requests. Every agent runs on the GitHub Copilot SDK (`@github/copilot-sdk`) and uses the signed-in user's own Copilot plan. Each bot has its own model.

Spec and decisions: https://github.com/JorgeMenaDev/matias/issues/970 (spec comment). Research: matias vault `context/grok-bot-gcp.md`.

## Architecture

```
apps/desktop  Electron + React + Vite. GitHub device-flow sign-in, bot sidebar, chat, model picker, live screen (noVNC).
apps/control  Control plane: Node/TS HTTP + WebSocket, SQLite. Users, bots, runs, schedules, token broker, ComputerProvider.
apps/worker   Runs inside each bot computer. Dials out to control, runs Copilot SDK sessions (copilot-cli mode).
packages/contracts  Zod schemas for every message that crosses a process boundary. Types are inferred from them.
infra/        Bot computer Docker image; Terraform for GCP (written, NOT applied until Jorge approves spend).
```

- **Bot computer** = one Docker image (Xvfb + Chromium + noVNC + git + worker) with one volume per bot. It runs locally under Colima now and on GCP later, one Compute Engine VM per bot. Both sit behind one `ComputerProvider` interface (`create / start / stop / destroy / status`): `DockerProvider` (local) and `GceProvider` (GCP).
- **Tokens:** the desktop does device-flow sign-in, then hands the tokens to control. The refresh token never leaves control. Workers fetch short-lived access tokens from control's broker through the SDK's `gitHubTokenProvider`.
- **Durable state lives in control,** never only in a bot computer. Bots keep working when the desktop app is closed.
- **Multi-user data model** from day one: every row is owned by a `UserId`.

## Rules

- TypeScript strict, no `any`, no casting wrappers. Zod schemas in `packages/contracts` are the source of types. Infer them, don't restate them.
- Keep it simple (YAGNI). No abstraction until a second caller exists. `ComputerProvider` is the one planned seam.
- Build each ticket test-first (`tdd`). Tests are focused, with no smoke-test sprawl. Tests use fakes for Copilot, Docker and GCP, so `bun test` needs no network, Docker or tokens.
- **No GCP spend.** Never run `terraform apply` or create any cloud resource. GCP code is tested with fakes only.
- **Copilot Free has 200 chats/month.** Live Copilot calls happen only in explicitly named manual checks, at most a handful per ticket.
- Never print or commit tokens. `.env*` is git-ignored.
- T3 Code (https://github.com/pingdotgg/t3code, MIT, local clone `~/.btca/agent/sandbox/t3code`) is the UX and architecture reference. Ported code keeps T3's MIT notice in `THIRD_PARTY_NOTICES.md`.
- Commands: `bun install`, `bun run check` (typecheck + tests). CI runs the same.
- Conventional commits: `feat(control): …`, `fix(desktop): …`.
