import { afterEach, expect, test } from "bun:test";
import { DEFAULT_AVATAR, SignInResponse } from "@chiefbot/contracts";
import { startControl } from "@chiefbot/control";
import { loadConnections, repoConnections } from "@chiefbot/control/connections";
import { fakeComputers } from "@chiefbot/control/fake-computers";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { createBots } from "./bots.ts";
import { createConnections } from "./connections.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

test("the user turns Jira on with their fields and off again, and reads a bot's connection calls", async () => {
  const github = startFakeGitHub();
  const computers = fakeComputers();
  const control = startControl({
    port: 0,
    dbPath: ":memory:",
    githubApiUrl: github.url,
    githubClientId: "test-client",
    githubApp: github.app,
    computers: computers.provider,
    connections: loadConnections(repoConnections),
  });
  stops.push(github.stop, computers.stopAll, control.stop);
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({ accessToken, accessTokenExpiresAt: Date.now() + 8 * 3600_000, refreshToken, refreshTokenExpiresAt: 0 }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  const session = () => sessionToken;
  const connections = createConnections({ controlUrl: control.url, session });

  const before = await connections.list();
  const jira = await connections.connect("jira", { site: "example.atlassian.net", email: "octo@example.com", token: "jira-token" });
  const refused = await connections.connect("jira", { site: "example.atlassian.net" }).catch((error: Error) => error.message);
  await connections.disconnect("jira");
  const bot = await createBots({ controlUrl: control.url, session, onChange: () => {} }).create({ name: "Ada", avatar: DEFAULT_AVATAR });

  expect(before.map(({ name, on }) => [name, on])).toEqual([
    ["dynatrace", false],
    ["gcloud", false],
    ["harness", false],
    ["jira", false],
    ["looker", false],
  ]);
  expect(jira.on).toBe(true);
  expect(refused).toContain("invalid_connection: email is missing");
  expect((await connections.list()).map(({ on }) => on)).toEqual([false, false, false, false, false]);
  expect(await connections.calls(bot.id)).toEqual([]);
  // Jira has no health probe: Health lists what it can check, and nothing of the user's yet.
  expect(await connections.health()).toEqual({ checkable: ["Dynatrace", "Google Cloud", "Looker"], connections: [] });
});
