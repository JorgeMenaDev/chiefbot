import { afterEach, expect, test } from "bun:test";
import { Workspace, WorkspaceDetail, WorkspaceInvite } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { cleanUp, startTestControl, type TestUser } from "./testControl.ts";

afterEach(cleanUp);

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: null };

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const workspaceOf = async (user: TestUser, name = "Platform team") =>
  Workspace.parse(await (await user.api("POST", "/workspaces", { name })).json());
const detailOf = async (user: TestUser, workspace: Workspace) =>
  WorkspaceDetail.parse(await (await user.api("GET", `/workspaces/${workspace.id}`)).json());
const invitesOf = async (user: TestUser) => WorkspaceInvite.array().parse(await (await user.api("GET", "/invites")).json());

test("a new workspace lists its creator as its owner", async () => {
  const { user } = await startTestControl();

  const res = await user.api("POST", "/workspaces", { name: "Platform team" });

  expect(res.status).toBe(201);
  const created = Workspace.parse(await res.json());
  expect(created).toMatchObject({ name: "Platform team", role: "owner" });
  expect(Workspace.array().parse(await (await user.api("GET", "/workspaces")).json())).toEqual([created]);
  const detail = WorkspaceDetail.parse(await (await user.api("GET", `/workspaces/${created.id}`)).json());
  expect(detail.members).toEqual([{ userId: expect.any(String), login: "octo-user", role: "owner" }]);
});

test("an invite by GitHub login waits until that login signs in and accepts it", async () => {
  const { user: owner, signIn } = await startTestControl();
  const team = await workspaceOf(owner);

  const invited = await json(await owner.api("POST", `/workspaces/${team.id}/invites`, { login: "Octo-Friend" }));

  expect(invited.status).toBe(201);
  const invite = WorkspaceInvite.parse(invited.body);
  expect(invite).toMatchObject({ workspaceId: team.id, workspaceName: "Platform team", login: "Octo-Friend", invitedBy: "octo-user" });
  expect((await detailOf(owner, team)).invites).toEqual([invite]);

  const guest = await signIn(friend);
  expect(await invitesOf(guest)).toEqual([invite]);
  expect((await guest.api("GET", `/workspaces/${team.id}`)).status).toBe(404);

  const accepted = await json(await guest.api("POST", `/invites/${invite.id}/accept`));

  expect(accepted).toEqual({ status: 200, body: { id: team.id, name: "Platform team", role: "member" } });
  expect(await invitesOf(guest)).toEqual([]);
  const detail = await detailOf(guest, team);
  expect(detail.members.map(({ login, role }) => [login, role])).toEqual([
    ["octo-user", "owner"],
    ["octo-friend", "member"],
  ]);
  expect(detail.invites).toEqual([]);
});

// The owner's workspace with octo-friend as an accepted member.
async function teamWithMember() {
  const control = await startTestControl();
  const owner = control.user;
  const team = await workspaceOf(owner);
  await owner.api("POST", `/workspaces/${team.id}/invites`, { login: friend.login });
  const guest = await control.signIn(friend);
  const [invite] = await invitesOf(guest);
  await guest.api("POST", `/invites/${invite?.id}/accept`);
  const guestId = (await detailOf(owner, team)).members.find(({ login }) => login === friend.login)?.userId;
  const ownerId = (await detailOf(owner, team)).members.find(({ role }) => role === "owner")?.userId;
  return { ...control, owner, guest, team, guestId, ownerId };
}

test("a member leaves, and then the workspace is gone for them", async () => {
  const { owner, guest, team, guestId } = await teamWithMember();

  expect((await guest.api("DELETE", `/workspaces/${team.id}/members/${guestId}`)).status).toBe(204);

  expect(await (await guest.api("GET", "/workspaces")).json()).toEqual([]);
  expect((await guest.api("GET", `/workspaces/${team.id}`)).status).toBe(404);
  expect((await detailOf(owner, team)).members.map(({ login }) => login)).toEqual(["octo-user"]);
});

test("the owner removes a member, but cannot leave their own workspace", async () => {
  const { owner, guest, team, guestId, ownerId } = await teamWithMember();

  expect(await json(await owner.api("DELETE", `/workspaces/${team.id}/members/${ownerId}`))).toEqual({
    status: 409,
    body: { error: "owner_cannot_leave" },
  });
  expect((await owner.api("DELETE", `/workspaces/${team.id}/members/${guestId}`)).status).toBe(204);

  expect((await guest.api("GET", `/workspaces/${team.id}`)).status).toBe(404);
  expect((await detailOf(owner, team)).members.map(({ login }) => login)).toEqual(["octo-user"]);
});

test("only the owner invites or removes others", async () => {
  const { owner, guest, team, ownerId } = await teamWithMember();

  const refused = { status: 403, body: { error: "owner_only" } };
  expect(await json(await guest.api("POST", `/workspaces/${team.id}/invites`, { login: "octo-third" }))).toEqual(refused);
  expect(await json(await guest.api("DELETE", `/workspaces/${team.id}/members/${ownerId}`))).toEqual(refused);
  expect((await detailOf(owner, team)).invites).toEqual([]);
});

test("the owner revokes an invite, and its login can no longer accept it", async () => {
  const { user: owner, signIn } = await startTestControl();
  const team = await workspaceOf(owner);
  const invite = WorkspaceInvite.parse(
    await (await owner.api("POST", `/workspaces/${team.id}/invites`, { login: friend.login })).json(),
  );

  expect((await owner.api("DELETE", `/workspaces/${team.id}/invites/${invite.id}`)).status).toBe(204);

  const guest = await signIn(friend);
  expect(await invitesOf(guest)).toEqual([]);
  expect((await guest.api("POST", `/invites/${invite.id}/accept`)).status).toBe(404);
  expect((await detailOf(owner, team)).invites).toEqual([]);
});

test("every workspace route answers 404 to a signed-in non-member, and 401 without a session", async () => {
  const { user: owner, signIn, url } = await startTestControl();
  const team = await workspaceOf(owner);
  const ownerId = (await detailOf(owner, team)).members[0]?.userId;
  const invite = WorkspaceInvite.parse(
    await (await owner.api("POST", `/workspaces/${team.id}/invites`, { login: "octo-third" })).json(),
  );
  const stranger = await signIn(friend);
  const routes: Array<[string, string, unknown?]> = [
    ["GET", `/workspaces/${team.id}`],
    ["POST", `/workspaces/${team.id}/invites`, { login: friend.login }],
    ["DELETE", `/workspaces/${team.id}/invites/${invite.id}`],
    ["DELETE", `/workspaces/${team.id}/members/${ownerId}`],
    ["POST", `/invites/${invite.id}/accept`],
  ];

  for (const [method, path, body] of routes) {
    expect([method, path, await json(await stranger.api(method, path, body))]).toEqual([
      method,
      path,
      { status: 404, body: { error: "not_found" } },
    ]);
    expect((await fetch(`${url}${path}`, { method })).status).toBe(401);
  }
  expect(await (await stranger.api("GET", "/workspaces")).json()).toEqual([]);
  expect(await invitesOf(stranger)).toEqual([]);
  const detail = await detailOf(owner, team);
  expect(detail.members.map(({ login }) => login)).toEqual(["octo-user"]);
  expect(detail.invites).toEqual([invite]);
  expect((await owner.api("GET", "/workspaces/workspace_unknown")).status).toBe(404);
});

test("an invite needs a valid login of someone not yet a member, and inviting a login twice keeps one invite", async () => {
  const { owner, team } = await teamWithMember();
  const invite = (login: unknown) => owner.api("POST", `/workspaces/${team.id}/invites`, { login });

  expect(await json(await invite("not a login"))).toEqual({ status: 400, body: { error: "invalid_invite" } });
  expect(await json(await invite("OCTO-FRIEND"))).toEqual({ status: 409, body: { error: "already_member" } });
  const first = await json(await invite("octo-third"));
  const again = await json(await invite("Octo-Third"));
  expect(again).toEqual(first);
  expect((await detailOf(owner, team)).invites).toHaveLength(1);
  expect(await json(await owner.api("POST", "/workspaces", { name: " " }))).toEqual({
    status: 400,
    body: { error: "invalid_workspace" },
  });
});
