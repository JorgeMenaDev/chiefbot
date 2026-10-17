import { afterEach, expect, test } from "bun:test";
import {
  ApiError,
  ChecklistItem,
  ConnectStart,
  Connector,
  ConnectorCall,
  connectorPresets,
  Project,
  User,
  Workspace,
  WorkspaceInvite,
  type ConnectorInput,
} from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { sdk } from "@chiefbot/worker/fake-copilot";
import type { SecretStore } from "../secrets/secretStore.ts";
import { atCleanUp, cleanUp, doneCount, startTestControl, type TestUser } from "../testControl.ts";
import { startFakeMcpServer } from "./fakeMcpServer.ts";

afterEach(cleanUp);

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } };

// A SecretStore in memory, so a test can see what control put in it.
function memorySecrets() {
  const values = new Map<string, string>();
  const store: SecretStore = {
    get: async (name) => values.get(name) ?? null,
    put: async (name, value) => void values.set(name, value),
    delete: async (name) => void values.delete(name),
  };
  // Only connector secrets: users' GitHub refresh tokens share the store.
  const connectorSecrets = () => [...values].filter(([name]) => name.startsWith("connector-")).map(([, value]) => value);
  return { store, connectorSecrets };
}

// Control with a workspace owned by the signed-in user and octo-friend as its member.
async function team() {
  const secrets = memorySecrets();
  const control = await startTestControl({ secrets: secrets.store });
  const owner = control.user;
  const workspace = Workspace.parse(await (await owner.api("POST", "/workspaces", { name: "Platform team" })).json());
  await owner.api("POST", `/workspaces/${workspace.id}/invites`, { login: friend.login });
  const guest = await control.signIn(friend);
  const [invite] = WorkspaceInvite.array().parse(await (await guest.api("GET", "/invites")).json());
  await guest.api("POST", `/invites/${invite?.id}/accept`);
  const path = `/workspaces/${workspace.id}/connectors`;
  // A project for a new repo whose project file declares `connectors`.
  const createProject = async (repo: string, connectors: string[]) => {
    control.github.createRepo(repo, { "chiefbot.project.yaml": `connectors: [${connectors.join(", ")}]\n` });
    return Project.parse(await (await owner.api("POST", `/workspaces/${workspace.id}/projects`, { repo })).json());
  };
  const define = async (input: ConnectorInput) => {
    const res = await owner.api("POST", path, input);
    if (res.status !== 201) throw new Error(`define failed: ${res.status} ${await res.text()}`);
    return Connector.parse(await res.json());
  };
  return { ...control, connectorSecrets: secrets.connectorSecrets, owner, guest, workspace, path, createProject, define };
}

const checklist = async (member: TestUser, path: string) =>
  ChecklistItem.array().parse(await (await member.api("GET", path.replace("/connectors", "/checklist"))).json());

const preset = (name: string) => {
  const found = connectorPresets.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no preset ${name}`);
  return found;
};

test("the owner defines connectors from presets or by hand; members see them, never their secrets", async () => {
  const { owner, guest, path, define, connectorSecrets, workspace } = await team();
  const ci: ConnectorInput = {
    name: "ci",
    title: "CI",
    server: { kind: "command", command: "npx", args: ["-y", "ci-mcp"], env: {}, tokenEnv: "CI_TOKEN" },
    auth: "workspace-secret",
    scope: "",
  };

  await define(preset("github"));
  await define(ci);
  const memberTry = await guest.api("POST", path, preset("jira"));
  const again = await owner.api("POST", path, preset("github"));
  const invalid = await owner.api("POST", path, { ...ci, name: "Not Valid" });
  const set = await owner.api("PUT", `${path}/ci/secret`, { token: "ci-service-token" });
  const memberSet = await guest.api("PUT", `${path}/ci/secret`, { token: "mine" });
  const wrongAuth = await owner.api("PUT", `${path}/github/secret`, { token: "x" });

  expect([memberTry.status, ApiError.parse(await memberTry.json()).error]).toEqual([403, "owner_only"]);
  expect([again.status, ApiError.parse(await again.json()).error]).toEqual([409, "connector_exists"]);
  expect([invalid.status, ApiError.parse(await invalid.json()).error]).toEqual([400, "invalid_connector"]);
  expect([set.status, memberSet.status, wrongAuth.status]).toEqual([204, 403, 400]);
  const seen = Connector.array().parse(await (await guest.api("GET", path)).json());
  expect(seen).toEqual([
    { ...preset("github"), workspaceId: workspace.id, hasWorkspaceSecret: false },
    { ...ci, workspaceId: workspace.id, hasWorkspaceSecret: true },
  ]);
  expect(connectorSecrets()).toEqual(["ci-service-token"]);
  expect(JSON.stringify(seen)).not.toContain("ci-service-token");

  expect((await owner.api("DELETE", `${path}/ci`)).status).toBe(204);
  expect(connectorSecrets()).toEqual([]);
  expect(Connector.array().parse(await (await owner.api("GET", path)).json()).map(({ name }) => name)).toEqual(["github"]);
});

test("a member's checklist is what their projects declare minus what is ready for them", async () => {
  const { owner, guest, path, define, createProject } = await team();
  await createProject("octo-org/shop", ["github", "jira", "pager"]);
  await createProject("octo-org/api", ["github", "ci", "docs"]);
  await define(preset("github"));
  await define(preset("jira"));
  await define({ name: "ci", title: "CI", server: { kind: "remote", url: "https://ci.example.com/mcp" }, auth: "workspace-secret", scope: "" });
  await define({ name: "docs", title: "Docs", server: { kind: "remote", url: "https://docs.example.com/mcp" }, auth: "none", scope: "" });

  const before = await checklist(guest, path);
  await guest.api("PUT", `${path}/github/token`, { token: "ghp_member" });
  await owner.api("PUT", `${path}/ci/secret`, { token: "ci-service-token" });

  expect(before).toEqual([
    { name: "github", title: "GitHub", auth: "personal-oauth", projects: ["shop", "api"], status: "connect" },
    { name: "jira", title: "Jira", auth: "personal-oauth", projects: ["shop"], status: "connect" },
    { name: "pager", title: null, auth: null, projects: ["shop"], status: "not-defined" },
    { name: "ci", title: "CI", auth: "workspace-secret", projects: ["api"], status: "workspace-secret" },
    { name: "docs", title: "Docs", auth: "none", projects: ["api"], status: "ready" },
  ]);
  expect((await checklist(guest, path)).map(({ name, status }) => [name, status])).toEqual([
    ["github", "ready"],
    ["jira", "connect"],
    ["pager", "not-defined"],
    ["ci", "ready"],
    ["docs", "ready"],
  ]);
  // The owner's own checklist: they have connected nothing.
  expect((await checklist(owner, path)).find(({ name }) => name === "github")?.status).toBe("connect");
});

// Sends a member's message to the project's coordinator and waits for its turn
// to end: the member's `nth` turn in this chat (default the first).
async function askAndWait(member: TestUser, projectId: Project["id"], text: string, nth = 1) {
  const res = await member.api("POST", `/projects/${projectId}/messages`, { text });
  if (res.status !== 202) throw new Error(`ask failed: ${res.status} ${await res.text()}`);
  await member.watchProjectChat(projectId).until(doneCount(nth));
}

test("a coordinator session gets only the connectors its project declares that are ready for the member", async () => {
  const { url, owner, guest, path, define, createProject, copilot, computers } = await team();
  const project = await createProject("octo-org/shop", ["github", "harness", "pager"]);
  await define(preset("github"));
  await define(preset("jira"));
  await define({
    name: "harness",
    title: "Harness",
    server: { kind: "command", command: "npx", args: ["-y", "harness-mcp-v2"], env: { HARNESS_DEFAULT_ORG_ID: "default" }, tokenEnv: "HARNESS_API_KEY" },
    auth: "workspace-secret",
    scope: "",
  });
  await owner.api("PUT", `${path}/harness/secret`, { token: "harness-service-key" });
  await guest.api("PUT", `${path}/github/token`, { token: "ghp_member" });
  await guest.api("PUT", `${path}/jira/token`, { token: "jira_member" });
  const projectToken = computers.computers.get(project.id)?.spec.env.CHIEFBOT_PROJECT_TOKEN ?? "";

  await askAndWait(guest, project.id, "hi");
  await askAndWait(owner, project.id, "hi");

  const [guestServers, ownerServers] = copilot.mcpServers;
  expect(Object.keys(guestServers ?? {})).toEqual(["github", "harness"]);
  expect(guestServers?.github).toEqual({
    type: "http",
    url: `${url}/coordinator/${project.id}/mcp/github`,
    headers: { authorization: `Bearer ${projectToken}`, "x-chiefbot-member": expect.any(String) },
    tools: ["*"],
  });
  expect(guestServers?.harness).toEqual({
    type: "local",
    command: "npx",
    args: ["-y", "harness-mcp-v2"],
    env: { HARNESS_DEFAULT_ORG_ID: "default", HARNESS_API_KEY: "harness-service-key" },
    tools: ["*"],
  });
  // The owner has not connected GitHub, so their session goes without it, until
  // they connect: their next turn resumes the same session with it.
  expect(Object.keys(ownerServers ?? {})).toEqual(["harness"]);
  await owner.api("PUT", `${path}/github/token`, { token: "ghp_owner" });
  await askAndWait(owner, project.id, "again", 2);
  expect(Object.keys(copilot.mcpServers[2] ?? {})).toEqual(["github", "harness"]);
  expect(copilot.sessionIds[2]).toBe(copilot.sessionIds[1] ?? "");
  // Control's proxy serves no connector the project does not declare.
  const undeclared = await fetch(`${url}/coordinator/${project.id}/mcp/jira`, {
    method: "POST",
    headers: { authorization: `Bearer ${projectToken}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(undeclared.status).toBe(404);
});

test("each connector call runs as the right identity and is logged with who asked, the identity, the project and the run", async () => {
  const { url, owner, guest, path, define, createProject, copilot, computers, signIn } = await team();
  const upstream = startFakeMcpServer();
  atCleanUp(upstream.stop);
  const remote = (name: string, auth: ConnectorInput["auth"]): ConnectorInput => ({ name, title: name, server: { kind: "remote", url: upstream.url }, auth, scope: "" });
  await define(remote("tracker", "personal-oauth"));
  await define(remote("ci", "workspace-secret"));
  await define({ name: "lint", title: "Lint", server: { kind: "command", command: "lint-mcp", args: [], env: {} }, auth: "none", scope: "" });
  const project = await createProject("octo-org/shop", ["tracker", "ci", "lint"]);
  await guest.api("PUT", `${path}/tracker/token`, { token: "tracker-guest" });
  await owner.api("PUT", `${path}/tracker/token`, { token: "tracker-owner" });
  await owner.api("PUT", `${path}/ci/secret`, { token: "ci-service" });
  const answers: unknown[] = [];
  copilot.script = async function* (_prompt, runtime) {
    answers.push((await runtime.callMcp("tracker", "list_issues")).body);
    await runtime.callMcp("ci", "list_runs");
    await runtime.callMcp("lint", "run_lint");
    yield sdk.idle();
  };

  await askAndWait(guest, project.id, "status?");
  await askAndWait(owner, project.id, "status?");

  expect(upstream.calls).toEqual([
    { tool: "list_issues", authorization: "Bearer tracker-guest" },
    { tool: "list_runs", authorization: "Bearer ci-service" },
    { tool: "list_issues", authorization: "Bearer tracker-owner" },
    { tool: "list_runs", authorization: "Bearer ci-service" },
  ]);
  expect(answers[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "list_issues ran" }] } });
  const log = ConnectorCall.array().parse(await (await guest.api("GET", `/projects/${project.id}/connector-calls`)).json());
  expect(log.map(({ connector, tool, requester, identity }) => [connector, tool, requester, identity])).toEqual([
    ["tracker", "list_issues", "octo-friend", "personal"],
    ["ci", "list_runs", "octo-friend", "workspace"],
    ["lint", "run_lint", "octo-friend", "none"],
    ["tracker", "list_issues", "octo-user", "personal"],
    ["ci", "list_runs", "octo-user", "workspace"],
    ["lint", "run_lint", "octo-user", "none"],
  ]);
  const runs = new Set(log.map(({ run }) => run));
  expect(runs.size).toBe(2);
  expect([...runs].every((run) => run.startsWith("turn_"))).toBe(true);
  // No call outside the member's turn, and no log for anyone outside the workspace.
  const guestId = User.parse(await (await guest.api("GET", "/me")).json()).id;
  const outside = await fetch(`${url}/coordinator/${project.id}/mcp/tracker`, {
    method: "POST",
    headers: { authorization: `Bearer ${computers.computers.get(project.id)?.spec.env.CHIEFBOT_PROJECT_TOKEN}`, "x-chiefbot-member": guestId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_issues" } }),
  });
  expect([outside.status, ApiError.parse(await outside.json()).error]).toEqual([409, "no_turn"]);
  const stranger = await signIn({ id: 6161, login: "octo-stranger", copilot: null });
  expect((await stranger.api("GET", `/projects/${project.id}/connector-calls`)).status).toBe(404);
});

test("a member connects with the MCP server's own OAuth sign-in when it offers one, and a token otherwise", async () => {
  const { guest, path, define, createProject, copilot } = await team();
  // Its access tokens expire at once, so control must refresh before the first call.
  const withOAuth = startFakeMcpServer({ oauth: true, accessTokenSeconds: 0 });
  const withoutOAuth = startFakeMcpServer();
  atCleanUp(withOAuth.stop);
  atCleanUp(withoutOAuth.stop);
  await define({ name: "jira", title: "Jira", server: { kind: "remote", url: withOAuth.url }, auth: "personal-oauth", scope: "read:jira" });
  await define({ name: "tracker", title: "Tracker", server: { kind: "remote", url: withoutOAuth.url }, auth: "personal-oauth", scope: "" });
  const project = await createProject("octo-org/shop", ["jira", "tracker"]);

  const start = ConnectStart.parse(await (await guest.api("POST", `${path}/jira/connect`)).json());
  const fallback = ConnectStart.parse(await (await guest.api("POST", `${path}/tracker/connect`)).json());
  if (start.kind !== "oauth") throw new Error("expected an OAuth sign-in");
  // The member's browser: the server approves and sends it to control's callback.
  const approved = await fetch(start.authorizeUrl, { redirect: "manual" });
  const callback = approved.headers.get("location") ?? "";
  const done = await fetch(callback);
  const replay = await fetch(callback);

  expect(fallback).toEqual({ kind: "token" });
  expect(new URL(start.authorizeUrl).searchParams.get("scope")).toBe("read:jira");
  expect(new URL(start.authorizeUrl).searchParams.get("code_challenge_method")).toBe("S256");
  expect([done.status, await done.text()]).toEqual([200, expect.stringContaining("Connected to Jira")]);
  expect(replay.status).toBe(400);
  expect((await checklist(guest, path)).map(({ name, status }) => [name, status])).toEqual([
    ["jira", "ready"],
    ["tracker", "connect"],
  ]);
  copilot.script = async function* (_prompt, runtime) {
    await runtime.callMcp("jira", "search");
    yield sdk.idle();
  };
  await askAndWait(guest, project.id, "find my issues");
  expect(withOAuth.issued).toEqual(["access-1", "access-2"]);
  expect(withOAuth.calls).toEqual([{ tool: "search", authorization: "Bearer access-2" }]);
});
