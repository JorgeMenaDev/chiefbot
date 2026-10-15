import { defaultGitHubClientId } from "@chiefbot/contracts";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { googleCompute } from "./computers/compute.ts";
import { computersConfig } from "./computers/config.ts";
import { dockerProvider } from "./computers/docker.ts";
import { gceProvider } from "./computers/gce.ts";
import { startControl } from "./control.ts";
import { googleSecretManager, secretManagerStore } from "./secrets/secretManager.ts";
import { localSecretStore, secretKeyFile } from "./secrets/secretStore.ts";

// Starts the control plane. Env (bot computer settings: see computers/config.ts):
//   CHIEFBOT_CONTROL_PORT        default 7410
//   CHIEFBOT_CONTROL_HOSTNAME    default 127.0.0.1; 0.0.0.0 on the GCP control VM, so bot VMs and IAP reach it
//   CHIEFBOT_DB_PATH             default .data/control.sqlite (relative to apps/control)
//   CHIEFBOT_GITHUB_API_URL      default https://api.github.com
//   CHIEFBOT_GITHUB_URL          default https://github.com (the refresh grant)
//   CHIEFBOT_GITHUB_CLIENT_ID    default Chartpilot's public OAuth App; must match the desktop's
//   CHIEFBOT_SECRET_KEY_FILE     default ~/.chiefbot/secret.key: the key that encrypts refresh
//                                tokens in the SQLite file. Made on first run. Not used with gce,
//                                which keeps refresh tokens in Secret Manager in CHIEFBOT_GCP_PROJECT.
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
  githubUrl: process.env.CHIEFBOT_GITHUB_URL ?? "https://github.com",
  githubClientId: process.env.CHIEFBOT_GITHUB_CLIENT_ID ?? defaultGitHubClientId,
  secrets:
    config.provider === "gce"
      ? secretManagerStore(googleSecretManager(config))
      : localSecretStore({
          dbPath,
          key: secretKeyFile(process.env.CHIEFBOT_SECRET_KEY_FILE ?? join(homedir(), ".chiefbot", "secret.key")),
        }),
  computers:
    config.provider === "gce"
      ? gceProvider({ ...config, client: googleCompute(config) })
      : dockerProvider(config),
  workerControlUrl: process.env.CHIEFBOT_WORKER_CONTROL_URL ?? `http://host.docker.internal:${port}`,
});
console.log(`control listening on ${control.url} with ${config.provider} computers`);
