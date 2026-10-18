import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chiefbotHome, configuredGitHubApp, configuredSignIn, writeLocalConfig, writeOwnerOnly } from "./config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), "chiefbot-config-"));
  dirs.push(dir);
  return dir;
};

const app = { id: 7, slug: "chiefbot-abc123", clientId: "Iv-test-client", owner: "octo-user", htmlUrl: "https://github.com/apps/chiefbot-abc123" };

test("the Chiefbot home is ~/.chiefbot unless CHIEFBOT_HOME says otherwise", () => {
  expect(chiefbotHome({}, "/home/ada")).toBe("/home/ada/.chiefbot");
  expect(chiefbotHome({ CHIEFBOT_HOME: "/srv/chiefbot" }, "/home/ada")).toBe("/srv/chiefbot");
});

const signInApp = { id: 8, slug: "chiefbot-sign-in-abc123", clientId: "Iv-sign-in-client", owner: "octo-user", htmlUrl: "https://github.com/apps/chiefbot-sign-in-abc123" };

test("control and the desktop sign in with the sign-in app setup wrote, never the repo app", () => {
  const home = tempHome();
  const env = { CHIEFBOT_HOME: join(home, "nested") };
  expect(configuredSignIn(env, home)).toBeNull();

  writeLocalConfig(env.CHIEFBOT_HOME, { githubApp: app, signIn: { kind: "github-app", app: signInApp } });

  expect(configuredSignIn(env, home)).toEqual({ kind: "github-app", clientId: "Iv-sign-in-client" });
});

test("the sign-in app may be an OAuth App instead", () => {
  const home = tempHome();
  writeLocalConfig(home, { githubApp: app, signIn: { kind: "oauth-app", clientId: "oauth-client" } });

  expect(configuredSignIn({ CHIEFBOT_HOME: home }, home)).toEqual({ kind: "oauth-app", clientId: "oauth-client" });
});

test("a config from before the sign-in app has no sign-in: setup must add it", () => {
  const home = tempHome();
  writeLocalConfig(home, { githubApp: app });

  expect(configuredSignIn({ CHIEFBOT_HOME: home }, home)).toBeNull();
});

test("CHIEFBOT_GITHUB_CLIENT_ID wins over the config file's sign-in client ID", () => {
  const home = tempHome();
  writeLocalConfig(home, { githubApp: app, signIn: { kind: "oauth-app", clientId: "oauth-client" } });
  expect(configuredSignIn({ CHIEFBOT_HOME: home, CHIEFBOT_GITHUB_CLIENT_ID: "from-env" }, home)).toEqual({ kind: "oauth-app", clientId: "from-env" });
  expect(configuredSignIn({ CHIEFBOT_GITHUB_CLIENT_ID: "Iv-from-env" }, tempHome())).toEqual({ kind: "github-app", clientId: "Iv-from-env" });
});

test("control reads the app's ID and the private key setup saved beside it", () => {
  const home = tempHome();
  expect(configuredGitHubApp({ CHIEFBOT_HOME: home }, home)).toBeNull();

  writeLocalConfig(home, { githubApp: app });
  writeOwnerOnly(home, "github-app-secrets.json", JSON.stringify({ clientSecret: "s", webhookSecret: null, privateKey: "-----PEM-----" }));

  expect(configuredGitHubApp({ CHIEFBOT_HOME: home }, home)).toEqual({ id: 7, privateKey: "-----PEM-----" });
});
