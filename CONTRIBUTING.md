# Contributing to Chiefbot

Thanks for helping. Chiefbot is a proof of concept, so small, focused pull requests land fastest.

## Before you start

- Read `AGENTS.md`: the architecture and the rules every change follows (strict TypeScript with no `any`, Zod schemas in `packages/contracts` as the source of types, no abstraction without a second caller).
- For anything bigger than a fix, open an issue first so we can agree on the shape.

## Set up

Follow the quickstart in `README.md`. Tests need none of it: `bun install` then `bun run check`.

## Make the change

- Build test-first. Tests use fakes for GitHub, Copilot, Docker and GCP (`packages/fake-github`, `apps/worker`'s fake Copilot, `apps/control/src/computers/fake*.ts`), so `bun test` needs no network, Docker or tokens. Keep tests focused on behaviour.
- Behaviour that needs real Docker gets a live test that `bun test` skips unless `CHIEFBOT_DOCKER_TESTS=1` (`*.live.test.ts`, such as `apps/control/src/templates/stacks.live.test.ts`) where a live test can show it, and a numbered manual check in `README.md` otherwise.
- Behaviour that needs the real GitHub, Copilot or GCP gets a numbered manual check in `README.md` instead of a test. Copilot Free has 200 chats a month: keep live chats in a manual check to a handful.
- Never run `terraform apply` or create cloud resources from a change. GCP code is tested with fakes.
- Never commit tokens, keys or `.env` files. Your GitHub App's secrets live in `~/.chiefbot/`, outside the repo.
- Keep the code generic: no personal or company names, client IDs or private links. `bun run check` runs `scripts/check-public.sh`, which fails on them.
- Ported code keeps its licence notice in `THIRD_PARTY_NOTICES.md`.

## Open the pull request

- `bun run check` is green (CI runs the same).
- Commits and the title follow Conventional Commits: `feat(control): …`, `fix(desktop): …`, `docs: …`.
- The description says what was wrong or missing, then how the change fixes it, and lists any manual check you ran.

By contributing you agree that your contribution is licensed under the MIT licence in `LICENSE`.
