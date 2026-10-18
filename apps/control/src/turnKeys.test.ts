import { afterEach, expect, test } from "bun:test";
import { ApiError, BrokeredGitHubToken, Project, Task, User, Workspace, WorkspaceInvite, type ChatEvent, type ProjectId } from "@chiefbot/contracts";
import { sdk } from "@chiefbot/worker/fake-copilot";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { startFakeMcpServer } from "./connectors/fakeMcpServer.ts";
import { atCleanUp, cleanUp, doneCount, eventually, fakeCoordinator, startTestControl, type TestControlOptions, type TestUser } from "./testControl.ts";

afterEach(cleanUp);

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } };

// Control with a workspace owned by the signed-in user, octo-friend as its
// member, and a project for octo-org/shop whose project file has `file`.
async function team(file = "", options: TestControlOptions = {}) {
  const control = await startTestControl(options);
  const owner = control.user;
  const workspace = Workspace.parse(await (await owner.api("POST", "/workspaces", { name: "Platform team" })).json());
  await owner.api("POST", `/workspaces/${workspace.id}/invites`, { login: friend.login });
  const guest = await control.signIn(friend);
  const [invite] = WorkspaceInvite.array().parse(await (await guest.api("GET", "/invites")).json());
  await guest.api("POST", `/invites/${invite?.id}/accept`);
  control.github.createRepo("octo-org/shop", { "chiefbot.project.yaml": file });
  const project = Project.parse(await (await owner.api("POST", `/workspaces/${workspace.id}/projects`, { repo: "octo-org/shop" })).json());
  return { ...control, owner, guest, workspace, project };
}

// Calls a coordinator route of the project with `bearer`.
const asCoordinator = (url: string, projectId: ProjectId, bearer: string) => (path: string, init: RequestInit = {}) =>
  fetch(`${url}/coordinator/${projectId}${path}`, { ...init, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" } });

const ask = async (member: TestUser, projectId: ProjectId, text: string) => {
  const res = await member.api("POST", `/projects/${projectId}/messages`, { text });
  if (res.status !== 202) throw new Error(`ask failed: ${res.status} ${await res.text()}`);
};

const refusal = async (res: Response) => [res.status, ApiError.parse(await res.json()).error];

test("a turn's key reaches only its own member's sign-in, only while that turn runs", async () => {
  const control = await team();
  const { url, owner, guest, project } = control;
  const coordinator = await fakeCoordinator(control, project.id);
  coordinator.hello(null);

  await ask(owner, project.id, "first");
  const first = await coordinator.nth("run-turn");
  const call = asCoordinator(url, project.id, first.turnKey);
  const inTurn = await call("/github-token");
  const withCredential = await asCoordinator(url, project.id, coordinator.token)("/github-token");
  coordinator.event(first.turnId, { type: "done" });
  await ask(guest, project.id, "second");
  const second = await coordinator.nth("run-turn", 2);
  const afterTurn = [await call("/github-token"), await call("/tools", { method: "POST", body: JSON.stringify({ tool: "list_tasks" }) })];
  const guestSeat = await asCoordinator(url, project.id, second.turnKey)("/github-token");

  expect([inTurn.status, BrokeredGitHubToken.parse(await inTurn.json()).accessToken]).toEqual([200, owner.tokens.accessToken]);
  expect(await refusal(withCredential)).toEqual([403, "invalid_turn_key"]);
  for (const res of afterTurn) expect(await refusal(res)).toEqual([403, "invalid_turn_key"]);
  expect(BrokeredGitHubToken.parse(await guestSeat.json()).accessToken).toBe(guest.tokens.accessToken);
});

// A team whose project declares a remote connector `tracker` (a fake MCP server
// whose create_issue may write), connected for the owner.
async function teamWithTracker(options: TestControlOptions = {}) {
  const upstream = startFakeMcpServer({ writes: ["create_issue"] });
  atCleanUp(upstream.stop);
  const control = await team("connectors: [tracker]\n", options);
  const connectors = `/workspaces/${control.workspace.id}/connectors`;
  await control.owner.api("POST", connectors, { name: "tracker", title: "Tracker", server: { kind: "remote", url: upstream.url }, auth: "personal-oauth", scope: "" });
  await control.owner.api("PUT", `${connectors}/tracker/token`, { token: "tracker-owner" });
  return { ...control, upstream };
}

// One JSON-RPC request to the project's tracker through control's proxy, with `turnKey`.
const rpc = (url: string, projectId: ProjectId, turnKey: string, method: string, params: object = {}) =>
  fetch(`${url}/coordinator/${projectId}/mcp/tracker`, {
    method: "POST",
    headers: { authorization: `Bearer ${turnKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

const approvalRequests = (events: ChatEvent[]) => events.flatMap(({ event }) => (event.type === "approval-request" ? [event] : []));

test("an approval asked in one turn is answered and used only in that turn", async () => {
  const control = await teamWithTracker();
  const { url, owner, project, upstream } = control;
  const coordinator = await fakeCoordinator(control, project.id);
  coordinator.hello(null);
  const chat = owner.watchProjectChat(project.id);
  const answer = (approvalId: string) => owner.api("POST", `/projects/${project.id}/approvals/${approvalId}`, { approved: true });
  const createIssue = (turnKey: string) => rpc(url, project.id, turnKey, "tools/call", { name: "create_issue" });

  await ask(owner, project.id, "File the bug");
  const a = await coordinator.nth("run-turn");
  const heldInA = createIssue(a.turnKey);
  const [askedInA] = approvalRequests(await chat.until((events) => approvalRequests(events).length === 1));
  coordinator.event(a.turnId, { type: "done" });
  const endedA = await heldInA;
  await ask(owner, project.id, "File it again");
  const b = await coordinator.nth("run-turn", 2);
  const fromA = await createIssue(a.turnKey);
  const answeredInB = await answer(askedInA?.approvalId ?? "");
  const heldInB = createIssue(b.turnKey);
  const [, askedInB] = approvalRequests(await chat.until((events) => approvalRequests(events).length === 2));
  const approvedInB = await answer(askedInB?.approvalId ?? "");

  expect(await refusal(endedA)).toEqual([409, "no_turn"]);
  expect(await refusal(fromA)).toEqual([403, "invalid_turn_key"]);
  expect(await refusal(answeredInB)).toEqual([409, "not_pending"]);
  expect(askedInB?.approvalId).not.toBe(askedInA?.approvalId);
  expect([approvedInB.status, (await heldInB).status]).toEqual([204, 200]);
  expect(chat.events.find(({ event }) => event.type === "approval-request" && event.approvalId === askedInB?.approvalId)?.turnId).toBe(b.turnId);
  expect(upstream.calls).toEqual([{ tool: "create_issue", authorization: "Bearer tracker-owner" }]);
});

test("a member removed mid-turn: their turn's key stops working at once, their coordinator session is told to stop, and the next turn is the next member's own", async () => {
  const control = await team();
  const { url, owner, guest, workspace, project } = control;
  const coordinator = await fakeCoordinator(control, project.id);
  coordinator.hello(null);
  const guestId = User.parse(await (await guest.api("GET", "/me")).json()).id;
  const tool = (turnKey: string, call: object) => asCoordinator(url, project.id, turnKey)("/tools", { method: "POST", body: JSON.stringify(call) });
  await ask(guest, project.id, "Hold on");
  const guestTurn = await coordinator.nth("run-turn");
  await ask(owner, project.id, "Next");

  expect((await owner.api("DELETE", `/workspaces/${workspace.id}/members/${guestId}`)).status).toBe(204);

  expect(await coordinator.nth("member-removed")).toEqual({ type: "member-removed", userId: guestId });
  const ownerTurn = await coordinator.nth("run-turn", 2);
  const late = [await tool(guestTurn.turnKey, { tool: "create_task", title: "Sneak in" }), await asCoordinator(url, project.id, guestTurn.turnKey)("/github-token")];
  const created = await tool(ownerTurn.turnKey, { tool: "create_task", title: "Owner's task" });

  expect(ownerTurn.member.login).toBe("octo-user");
  for (const res of late) expect(await refusal(res)).toEqual([403, "invalid_turn_key"]);
  expect(Task.parse(await created.json())).toMatchObject({ title: "Owner's task", requestedBy: "octo-user" });
});

test("the coordinator stops a removed member's session: what it does later reaches control as no one", async () => {
  const { owner, guest, workspace, project, copilot } = await team();
  const guestId = User.parse(await (await guest.api("GET", "/me")).json()).id;
  let wake = () => {};
  const late: unknown[] = [];
  copilot.script = async function* (prompt, runtime) {
    if (prompt === "Hold on") {
      // The runtime goes on after the member is removed, as a stuck one would.
      await new Promise<void>((resolve) => (wake = resolve));
      late.push(await runtime.tool("create_task", { title: "Sneak in" }).catch((error: Error) => error.message));
    }
    yield sdk.idle();
  };
  await ask(guest, project.id, "Hold on");
  await eventually(() => copilot.sends.length === 1);

  await owner.api("DELETE", `/workspaces/${workspace.id}/members/${guestId}`);
  const guestSession = `${project.id}-${guestId}`;
  await eventually(() => copilot.closed.includes(guestSession));
  await ask(owner, project.id, "Next");
  await owner.watchProjectChat(project.id).until(doneCount(1));
  wake();
  await eventually(() => late.length === 1);

  expect(copilot.aborted).toContain(guestSession);
  expect(late).toEqual(["This member's turn is not running, so Chiefbot refuses this call."]);
  expect(await (await owner.api("GET", `/projects/${project.id}/tasks`)).json()).toEqual([]);
});
