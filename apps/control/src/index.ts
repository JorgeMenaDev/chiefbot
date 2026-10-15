import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { startControl } from "./control.ts";

// Starts the control plane. Env:
//   CHIEFBOT_CONTROL_PORT    default 7410
//   CHIEFBOT_DB_PATH         default .data/control.sqlite (relative to apps/control)
//   CHIEFBOT_GITHUB_API_URL  default https://api.github.com
const dbPath = process.env.CHIEFBOT_DB_PATH ?? ".data/control.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });

const control = startControl({
  port: Number(process.env.CHIEFBOT_CONTROL_PORT ?? 7410),
  dbPath,
  githubApiUrl: process.env.CHIEFBOT_GITHUB_API_URL ?? "https://api.github.com",
});
console.log(`control listening on ${control.url}`);
