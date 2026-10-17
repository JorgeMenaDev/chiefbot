import { chiefbotHome, configuredGitHubApp, configuredGitHubClientId, setupNeeded } from "@chiefbot/setup";
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
//   CHIEFBOT_GITHUB_CLIENT_ID    default: the GitHub App `bun run setup` registered (~/.chiefbot/config.json);
//                                must match the desktop's
//   CHIEFBOT_HOME                default ~/.chiefbot: setup's config and secrets (the GitHub App's ID and
//                                private key, with which control reaches repos for bots), and the secret key
//   CHIEFBOT_SECRET_KEY_FILE     default ~/.chiefbot/secret.key: the key that encrypts refresh
//                                tokens in the SQLite file. Made on first run. Not used with gce,
//                                which keeps refresh tokens in Secret Manager in CHIEFBOT_GCP_PROJECT.
//   CHIEFBOT_COMPUTERS           docker (default) | gce
//   CHIEFBOT_WORKER_CONTROL_URL  default http://host.docker.internal:<port> (control as containers reach it)
//   CHIEFBOT_IDLE_STOP_MINUTES   default 30: an idle bot's computer stops after this long
const port = Number(process.env.CHIEFBOT_CONTROL_PORT ?? 7410);
const idleStopMinutes = Number(process.env.CHIEFBOT_IDLE_STOP_MINUTES ?? 30);
if (!(idleStopMinutes > 0)) throw new Error("CHIEFBOT_IDLE_STOP_MINUTES must be a positive number of minutes");
const githubClientId = configuredGitHubClientId(process.env, homedir());
const githubApp = configuredGitHubApp(process.env, homedir());
if (githubClientId === null || githubApp === null) {
  console.error(setupNeeded);
  process.exit(1);
}
const dbPath = process.env.CHIEFBOT_DB_PATH ?? ".data/control.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });

const config = computersConfig(process.env, homedir());
const control = startControl({
  port,
  hostname: process.env.CHIEFBOT_CONTROL_HOSTNAME ?? "127.0.0.1",
  dbPath,
  githubApiUrl: process.env.CHIEFBOT_GITHUB_API_URL ?? "https://api.github.com",
  githubUrl: process.env.CHIEFBOT_GITHUB_URL ?? "https://github.com",
  githubClientId,
  githubApp,
  secrets:
    config.provider === "gce"
      ? secretManagerStore(googleSecretManager(config))
      : localSecretStore({
          dbPath,
          key: secretKeyFile(process.env.CHIEFBOT_SECRET_KEY_FILE ?? join(chiefbotHome(process.env, homedir()), "secret.key")),
        }),
  computers:
    config.provider === "gce"
      ? gceProvider({ ...config, client: googleCompute(config) })
      : dockerProvider(config),
  workerControlUrl: process.env.CHIEFBOT_WORKER_CONTROL_URL ?? `http://host.docker.internal:${port}`,
  idleStopMinutes,
});
console.log(`control listening on ${control.url} with ${config.provider} computers`);
