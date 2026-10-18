import { afterEach, expect, test } from "bun:test";
import { ApiError, BrokeredGitHubToken, Project, Workspace, WorkspaceInvite, type ProjectId } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { cleanUp, fakeCoordinator, startTestControl, type TestControlOptions, type TestUser } from "./testControl.ts";

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
