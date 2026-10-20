import { afterEach, expect, test } from "bun:test";
import { DEFAULT_AVATAR, ServiceInput, SignInResponse } from "@chiefbot/contracts";
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

// Control with the repo's connections, whose services every name answers UP, and a
// signed-in user's session.
async function signedIn() {
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
    serviceNet: { lookup: async () => [{ address: "203.0.113.10", family: 4 }], fetch: async () => Response.json({ status: "UP" }) },
  });
  stops.push(github.stop, computers.stopAll, control.stop);
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({ accessToken, accessTokenExpiresAt: Date.now() + 8 * 3600_000, refreshToken, refreshTokenExpiresAt: 0 }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  return { controlUrl: control.url, session: () => sessionToken };
}

test("the user turns Jira on with their fields and off again, and reads a bot's connection calls", async () => {
  const { controlUrl, session } = await signedIn();
  const connections = createConnections({ controlUrl, session });

  const before = await connections.list();
  const jira = await connections.connect("jira", { site: "example.atlassian.net", email: "octo@example.com", token: "jira-token" });
  const refused = await connections.connect("jira", { site: "example.atlassian.net" }).catch((error: Error) => error.message);
  await connections.disconnect("jira");
  const bot = await createBots({ controlUrl, session, onChange: () => {} }).create({ name: "Ada", avatar: DEFAULT_AVATAR });

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
  expect(await connections.health()).toEqual({ checkable: ["Dynatrace", "Google Cloud", "Looker"], connections: [], services: [] });
});

test("the user tests, adds, checks, edits and removes a service of their own", async () => {
  const connections = createConnections(await signedIn());
  const input = ServiceInput.parse({
    name: "Meta",
    icon: "data",
    environments: [{ name: "prod", url: "https://meta.example.com/actuator/health", auth: { kind: "bearer" }, secret: "token-0123456789" }],
  });
  const [prod] = input.environments;
  if (!prod) throw new Error("expected prod");

  const tested = await connections.testEnvironment(prod);
  const service = await connections.addService(input);
  const checked = await connections.checkService(service.id);
  const [saved] = service.environments.map(({ id, name, url, auth }) => ({ id, name, url, auth }));
  if (!saved) throw new Error("expected prod saved");
  const renamed = await connections.updateService(service.id, { ...input, name: "Metadata", environments: [saved] });
  const all = await connections.checkServices();
  const refused = await connections.updateService(service.id, { ...input, environments: [{ ...saved, url: "https://elsewhere.example.com/health" }] }).catch((error: Error) => error.message);
  await connections.removeService(service.id);

  expect(tested).toMatchObject({ status: "ok", code: 200, bodyStatus: "UP" });
  expect(checked.map(({ name, environments }) => [name, environments.map(({ latest }) => latest?.status)])).toEqual([["Meta", ["ok"]]]);
  expect(renamed.name).toBe("Metadata");
  expect(all[0]?.environments[0]?.recent).toHaveLength(2);
  expect(refused).toContain("invalid_service: prod needs its token");
  expect((await connections.health()).services).toEqual([]);
  expect(JSON.stringify([service, checked, renamed, all])).not.toContain("token-0123456789");
});
