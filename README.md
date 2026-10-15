# Chiefbot

Personal chief-of-staff bots, each with its own computer, powered by the GitHub Copilot SDK on your own Copilot plan.

Status: proof of concept. It runs locally, with bot computers as Docker containers under Colima. The GCP deploy (one Compute Engine VM per bot) is written but not deployed.

See `AGENTS.md` for the architecture.

```bash
bun install
bun run check
```
