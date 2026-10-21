import { chiefbotHome, configuredGitHubApp, configuredSignIn, setupNeeded } from "@chiefbot/setup";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { googleCompute } from "./computers/compute.ts";
import { computersConfig } from "./computers/config.ts";
import { loadConnections, repoConnections } from "./connections/catalog.ts";
import { dockerProvider } from "./computers/docker.ts";
import { gceProvider } from "./computers/gce.ts";
import { startControl } from "./control.ts";
import { loadTemplates, repoTemplates } from "./templates/catalog.ts";
import { dockerStacks } from "./templates/stacks.ts";
import { googleSecretManager, restoreSetup, secretManagerStore } from "./secrets/secretManager.ts";
import { localSecretStore, secretKeyFile } from "./secrets/secretStore.ts";

// Starts the control plane. Env (bot computer settings: see computers/config.ts):
//   CHIEFBOT_CONTROL_PORT        default 7410
//   CHIEFBOT_CONTROL_HOSTNAME    default 127.0.0.1; 0.0.0.0 in a container or on a VM, and on a Linux
//                                host whose bot containers dial it (docs/deploy.md)
//   CHIEFBOT_DB_PATH             default .data/control.sqlite (relative to apps/control)
//   CHIEFBOT_GITHUB_API_URL      default https://api.github.com
//   CHIEFBOT_GITHUB_URL          default https://github.com (the refresh grant)
//   CHIEFBOT_GITHUB_CLIENT_ID    default: the sign-in app `bun run setup` recorded (~/.chiefbot/config.json);
//                                must match the desktop's
//   CHIEFBOT_HOME                default ~/.chiefbot: setup's config and secrets (the repo app's ID and
//                                private key, with which control reaches repos for bots), and the secret key.
//                                With gce, control first writes setup's files there from Secret Manager.
//   CHIEFBOT_SECRET_KEY_FILE     default ~/.chiefbot/secret.key: the key that encrypts refresh
//                                tokens in the SQLite file. Made on first run. Not used with gce,
//                                which keeps refresh tokens in Secret Manager in CHIEFBOT_GCP_PROJECT.
//   CHIEFBOT_COMPUTERS           docker (default) | gce
//   CHIEFBOT_WORKER_CONTROL_URL  default http://host.docker.internal:<port> (control as containers reach it)
//   CHIEFBOT_IDLE_STOP_MINUTES   default 30: an idle bot's or coordinator's computer stops after this long
//   CHIEFBOT_APPROVAL_WAIT_MINUTES  default 60: a project's worker waiting this long on one approval
//                                stops, keeping its disk
//   CHIEFBOT_PUBLIC_URL          default http://127.0.0.1:<port>: control as members' browsers reach it
//                                (connector OAuth sign-ins return to <it>/connectors/oauth/callback)
//   CHIEFBOT_CONNECTIONS_DIR     default the repo's connections/: the connections people may turn on.
//                                A folder that breaks a rule stops control here, naming the file.
//   CHIEFBOT_TEMPLATES_DIR       default the repo's templates/: the template catalog (docs/templates.md).
//                                A template that breaks a rule stops control here, naming the file.
//                                With docker computers, engineers' stacks run from it (templates/stacks.ts),
//                                through the docker CLI and its compose plugin.
//   Behind a company network, with docker computers (docs/deploy.md, "Behind a company proxy";
//   computers/config.ts reads them; gce ignores them):
//   CHIEFBOT_IMAGE_PREFIX        a registry mirror put before template base images, e.g. registry.example.com/hub
//   HTTP_PROXY, HTTPS_PROXY, NO_PROXY (or their lower-case forms)  passed on to engineers' computers,
//                                their template stacks' builds and containers, and control's fetches of
//                                services' repos. Bun's fetch reads them for control's own calls too.
//   CHIEFBOT_CA_FILE             a PEM file of the network's CA certificate, added to the trust of the same.
//                                A file control cannot read stops it here.
const port = Number(process.env.CHIEFBOT_CONTROL_PORT ?? 7410);
const idleStopMinutes = Number(process.env.CHIEFBOT_IDLE_STOP_MINUTES ?? 30);
if (!(idleStopMinutes > 0)) throw new Error("CHIEFBOT_IDLE_STOP_MINUTES must be a positive number of minutes");
const approvalWaitMinutes = Number(process.env.CHIEFBOT_APPROVAL_WAIT_MINUTES ?? 60);
if (!(approvalWaitMinutes > 0)) throw new Error("CHIEFBOT_APPROVAL_WAIT_MINUTES must be a positive number of minutes");
const config = computersConfig(process.env, homedir());
if (config.provider === "gce") await restoreSetup(googleSecretManager(config), chiefbotHome(process.env, homedir()));
const signIn = configuredSignIn(process.env, homedir());
const githubApp = configuredGitHubApp(process.env, homedir());
if (signIn === null || githubApp === null) {
  console.error(setupNeeded);
  process.exit(1);
}
const connections = loadConnections(process.env.CHIEFBOT_CONNECTIONS_DIR ?? repoConnections);
const templatesDir = process.env.CHIEFBOT_TEMPLATES_DIR ?? repoTemplates;
const templates = loadTemplates(templatesDir);
const githubUrl = process.env.CHIEFBOT_GITHUB_URL ?? "https://github.com";
const dbPath = process.env.CHIEFBOT_DB_PATH ?? ".data/control.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });

const control = startControl({
  port,
  hostname: process.env.CHIEFBOT_CONTROL_HOSTNAME ?? "127.0.0.1",
  dbPath,
  githubApiUrl: process.env.CHIEFBOT_GITHUB_API_URL ?? "https://api.github.com",
  githubUrl,
  githubClientId: signIn.clientId,
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
  approvalWaitMinutes,
  ...(process.env.CHIEFBOT_PUBLIC_URL ? { publicUrl: process.env.CHIEFBOT_PUBLIC_URL } : {}),
  firstBot: "Chief of Staff",
  connections,
  templates,
  stacks: config.provider === "gce" ? null : dockerStacks({ socketPath: config.socketPath, githubUrl, templatesDir }),
  ...(config.provider === "gce" ? {} : { network: config.network }),
});
console.log(`control listening on ${control.url} with ${config.provider} computers`);
