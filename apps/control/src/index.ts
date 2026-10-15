import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { googleCompute } from "./computers/compute.ts";
import { computersConfig } from "./computers/config.ts";
import { dockerProvider } from "./computers/docker.ts";
import { gceProvider } from "./computers/gce.ts";
import { startControl } from "./control.ts";

// Starts the control plane. Env (bot computer settings: see computers/config.ts):
//   CHIEFBOT_CONTROL_PORT        default 7410
//   CHIEFBOT_CONTROL_HOSTNAME    default 127.0.0.1; 0.0.0.0 on the GCP control VM, so bot VMs and IAP reach it
//   CHIEFBOT_DB_PATH             default .data/control.sqlite (relative to apps/control)
//   CHIEFBOT_GITHUB_API_URL      default https://api.github.com
//   CHIEFBOT_COMPUTERS           docker (default) | gce
//   CHIEFBOT_WORKER_CONTROL_URL  default http://host.docker.internal:<port> (control as containers reach it)
const port = Number(process.env.CHIEFBOT_CONTROL_PORT ?? 7410);
const dbPath = process.env.CHIEFBOT_DB_PATH ?? ".data/control.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });

const config = computersConfig(process.env, homedir());
const control = startControl({
  port,
  hostname: process.env.CHIEFBOT_CONTROL_HOSTNAME ?? "127.0.0.1",
  dbPath,
  githubApiUrl: process.env.CHIEFBOT_GITHUB_API_URL ?? "https://api.github.com",
  computers:
    config.provider === "gce"
      ? gceProvider({ ...config, client: googleCompute(config) })
      : dockerProvider(config),
  workerControlUrl: process.env.CHIEFBOT_WORKER_CONTROL_URL ?? `http://host.docker.internal:${port}`,
});
console.log(`control listening on ${control.url} with ${config.provider} computers`);
