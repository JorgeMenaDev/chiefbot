import { GitHubAppSecrets, LocalConfig, type SignInConfig } from "@chiefbot/contracts";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The per-user Chiefbot home that `bun run setup` fills: config.json (the
// deployer's repo app and sign-in app), github-app-secrets.json and control's secret.key.
// Everything in it is owner-only (folder 700, files 600) and outside the repo.

type Env = Record<string, string | undefined>;

// What control and the desktop print when there is no app to sign in with or no repo app.
export const setupNeeded =
  "Chiefbot is not set up, or was set up before it had a separate sign-in app. Run `bun run setup`: it registers your own two GitHub Apps (one to sign in, one for repos) and writes them to ~/.chiefbot/config.json, with the repo app's private key in github-app-secrets.json beside it (or in $CHIEFBOT_HOME).";

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

// The sign-in app: the desktop signs in with its client ID and control refreshes
// with it. CHIEFBOT_GITHUB_CLIENT_ID overrides the client ID; the kind comes
// from the config, else github-app. Null when neither exists: print `setupNeeded`.
export function configuredSignIn(env: Env, homeDir: string): { kind: SignInConfig["kind"]; clientId: string } | null {
  const signIn = readLocalConfig(chiefbotHome(env, homeDir))?.signIn;
  const clientId = env.CHIEFBOT_GITHUB_CLIENT_ID ?? (signIn?.kind === "github-app" ? signIn.app.clientId : signIn?.clientId);
  return clientId === undefined ? null : { kind: signIn?.kind ?? "github-app", clientId };
}

// The repo app's ID and private key, from config.json and github-app-secrets.json:
// control signs the app's JWTs with them to reach repos for bots. Null until
// setup has saved both.
export function configuredGitHubApp(env: Env, homeDir: string): { id: number; privateKey: string } | null {
  const dir = chiefbotHome(env, homeDir);
  const config = readLocalConfig(dir);
  const secrets = join(dir, "github-app-secrets.json");
  if (!config || !existsSync(secrets)) return null;
  return { id: config.githubApp.id, privateKey: GitHubAppSecrets.parse(JSON.parse(readFileSync(secrets, "utf8"))).privateKey };
}
