import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chiefbotHome, configuredGitHubClientId, writeLocalConfig } from "./config.ts";

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

test("control and the desktop read the client ID that setup wrote", () => {
  const home = tempHome();
  const env = { CHIEFBOT_HOME: join(home, "nested") };
  expect(configuredGitHubClientId(env, home)).toBeNull();

  writeLocalConfig(env.CHIEFBOT_HOME, { githubApp: app });

  expect(configuredGitHubClientId(env, home)).toBe("Iv-test-client");
});

test("CHIEFBOT_GITHUB_CLIENT_ID wins over the config file", () => {
  const home = tempHome();
  writeLocalConfig(home, { githubApp: app });
  expect(configuredGitHubClientId({ CHIEFBOT_HOME: home, CHIEFBOT_GITHUB_CLIENT_ID: "Iv-from-env" }, home)).toBe("Iv-from-env");
});
