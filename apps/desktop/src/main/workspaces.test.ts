import { afterEach, expect, test } from "bun:test";
import { SignInResponse } from "@chiefbot/contracts";
import { startControl } from "@chiefbot/control";
import { fakeComputers } from "@chiefbot/control/fake-computers";
import { startFakeGitHub, type FakeGitHubUser } from "@chiefbot/fake-github";
import { createWorkspaces } from "./workspaces.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

test("an owner invites a login; once it signs in it accepts, and the owner can remove it", async () => {
  const github = startFakeGitHub();
  const computers = fakeComputers();
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, githubClientId: "test-client", githubApp: github.app, computers: computers.provider });
  stops.push(github.stop, computers.stopAll, control.stop);
  // The desktop of `as` (default: the fake's user), signed in to control.
  const desktop = async (as?: FakeGitHubUser) => {
    const { accessToken, refreshToken } = github.issueTokens(as);
    const res = await fetch(`${control.url}/sessions`, {
      method: "POST",
      body: JSON.stringify({ accessToken, accessTokenExpiresAt: 0, refreshToken, refreshTokenExpiresAt: 0 }),
    });
    const { sessionToken } = SignInResponse.parse(await res.json());
    return createWorkspaces({ controlUrl: control.url, session: () => sessionToken });
  };
  const owner = await desktop();
  const team = await owner.create("Platform team");
  await owner.invite(team.id, "octo-friend");
  const guest = await desktop({ id: 5151, login: "octo-friend", copilot: null });

  const [invite] = await guest.invites();
  if (!invite) throw new Error("no invite");
  expect(await guest.accept(invite.id)).toEqual({ id: team.id, name: "Platform team", role: "member", copilotMode: "personal" });
  const { members } = await owner.detail(team.id);
  const member = members.find(({ login }) => login === "octo-friend");
  if (!member) throw new Error("not a member");
  expect(await guest.list()).toEqual([{ id: team.id, name: "Platform team", role: "member", copilotMode: "personal" }]);
  // The owner moves the projects' agents onto the organization's Copilot; the member sees it.
  expect(await owner.setCopilotMode(team.id, "org")).toMatchObject({ copilotMode: "org" });
  await expect(guest.setCopilotMode(team.id, "personal")).rejects.toThrow("owner_only");
  expect(await guest.list()).toEqual([{ id: team.id, name: "Platform team", role: "member", copilotMode: "org" }]);

  await owner.removeMember(team.id, member.userId);

  expect(await guest.list()).toEqual([]);
  await expect(guest.detail(team.id)).rejects.toThrow("not_found");
});
