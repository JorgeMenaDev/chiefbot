import { afterEach, expect, test } from "bun:test";
import { connectorPresets, SignInResponse, Workspace } from "@chiefbot/contracts";
import { startControl } from "@chiefbot/control";
import { fakeComputers } from "@chiefbot/control/fake-computers";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { createConnectors } from "./connectors.ts";
import { createProjects } from "./projects.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

test("the owner adds a preset; the checklist asks for it until the member connects a token", async () => {
  const github = startFakeGitHub();
  const computers = fakeComputers();
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, githubClientId: "test-client", githubApp: github.app, computers: computers.provider });
  stops.push(github.stop, computers.stopAll, control.stop);
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({ accessToken, accessTokenExpiresAt: Date.now() + 8 * 3600_000, refreshToken, refreshTokenExpiresAt: 0 }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  const options = { controlUrl: control.url, session: () => sessionToken };
  const team = Workspace.parse(
    await (await fetch(`${control.url}/workspaces`, { method: "POST", headers: { authorization: `Bearer ${sessionToken}` }, body: '{"name":"Platform team"}' })).json(),
  );
  github.createRepo("octo-org/shop", { "chiefbot.project.yaml": "connectors: [jira]\n" });
  const projects = createProjects({ ...options, onChat: () => {} });
  stops.push(projects.disconnect);
  await projects.create(team.id, "octo-org/shop");
  const connectors = createConnectors(options);
  const jira = connectorPresets.find(({ name }) => name === "jira");
  if (!jira) throw new Error("no jira preset");

  const before = await connectors.checklist(team.id);
  await connectors.define(team.id, { ...jira, server: { kind: "remote", url: `${github.url}/no-mcp-here` } });
  const added = await connectors.checklist(team.id);
  const start = await connectors.connect(team.id, "jira");
  await connectors.setToken(team.id, "jira", "jira-token");

  expect(before.map(({ name, status }) => [name, status])).toEqual([["jira", "not-defined"]]);
  expect(added.map(({ name, status }) => [name, status])).toEqual([["jira", "connect"]]);
  expect(start).toEqual({ kind: "token" });
  expect((await connectors.checklist(team.id)).map(({ name, status }) => [name, status])).toEqual([["jira", "ready"]]);
  expect((await connectors.list(team.id)).map(({ name }) => name)).toEqual(["jira"]);
});
