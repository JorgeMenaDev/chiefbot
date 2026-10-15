import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dockerProvider } from "./computers/docker.ts";
import { startControl } from "./control.ts";

// Starts the control plane. Env:
//   CHIEFBOT_CONTROL_PORT        default 7410
//   CHIEFBOT_DB_PATH             default .data/control.sqlite (relative to apps/control)
//   CHIEFBOT_GITHUB_API_URL      default https://api.github.com
//   CHIEFBOT_DOCKER_SOCKET       default DOCKER_HOST's unix socket, else Colima's ~/.colima/default/docker.sock
//   CHIEFBOT_COMPUTER_IMAGE      default chiefbot-computer:dev (bun run computer:build)
//   CHIEFBOT_WORKER_CONTROL_URL  default http://host.docker.internal:<port> (control as containers reach it)
const port = Number(process.env.CHIEFBOT_CONTROL_PORT ?? 7410);
const dbPath = process.env.CHIEFBOT_DB_PATH ?? ".data/control.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const dockerHost = process.env.DOCKER_HOST?.startsWith("unix://") ? process.env.DOCKER_HOST.slice("unix://".length) : undefined;

const control = startControl({
  port,
  dbPath,
  githubApiUrl: process.env.CHIEFBOT_GITHUB_API_URL ?? "https://api.github.com",
  computers: dockerProvider({
    socketPath: process.env.CHIEFBOT_DOCKER_SOCKET ?? dockerHost ?? join(homedir(), ".colima/default/docker.sock"),
    image: process.env.CHIEFBOT_COMPUTER_IMAGE ?? "chiefbot-computer:dev",
  }),
  workerControlUrl: process.env.CHIEFBOT_WORKER_CONTROL_URL ?? `http://host.docker.internal:${port}`,
});
console.log(`control listening on ${control.url}`);
