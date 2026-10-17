import { GitHubAppSecrets, LocalConfig } from "@chiefbot/contracts";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The per-user Chiefbot home that `bun run setup` fills: config.json (the
// deployer's GitHub App), github-app-secrets.json and control's secret.key.
// Everything in it is owner-only (folder 700, files 600) and outside the repo.

type Env = Record<string, string | undefined>;

// What control and the desktop print when there is no GitHub App to sign in with.
export const setupNeeded =
  "Chiefbot has no GitHub App yet. Run `bun run setup`: it registers your own GitHub App and writes its client ID to ~/.chiefbot/config.json and its private key to github-app-secrets.json beside it (or in $CHIEFBOT_HOME).";

// CHIEFBOT_HOME, default ~/.chiefbot.
export function chiefbotHome(env: Env, homeDir: string): string {
  return env.CHIEFBOT_HOME ?? join(homeDir, ".chiefbot");
}

// The config setup wrote, or null before setup has run.
export function readLocalConfig(dir: string): LocalConfig | null {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return null;
  return LocalConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeLocalConfig(dir: string, config: LocalConfig): void {
  writeOwnerOnly(dir, "config.json", `${JSON.stringify(config, null, 2)}\n`);
}

// Writes dir/name readable by the owner only, making dir (700) if needed.
export function writeOwnerOnly(dir: string, name: string, contents: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, name);
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// The OAuth client ID the desktop signs in with and control refreshes with:
// CHIEFBOT_GITHUB_CLIENT_ID (the GCP control VM sets it), else the app setup
// registered. Null when neither exists: print `setupNeeded`.
export function configuredGitHubClientId(env: Env, homeDir: string): string | null {
  return env.CHIEFBOT_GITHUB_CLIENT_ID ?? readLocalConfig(chiefbotHome(env, homeDir))?.githubApp.clientId ?? null;
}

// The app's ID and private key, from config.json and github-app-secrets.json:
// control signs the app's JWTs with them to reach repos for bots. Null until
// setup has saved both.
export function configuredGitHubApp(env: Env, homeDir: string): { id: number; privateKey: string } | null {
  const dir = chiefbotHome(env, homeDir);
  const config = readLocalConfig(dir);
  const secrets = join(dir, "github-app-secrets.json");
  if (!config || !existsSync(secrets)) return null;
  return { id: config.githubApp.id, privateKey: GitHubAppSecrets.parse(JSON.parse(readFileSync(secrets, "utf8"))).privateKey };
}
