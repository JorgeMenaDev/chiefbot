import { afterEach, expect, setSystemTime, test } from "bun:test";
import { ConnectorCall, Project, User, Workspace, WorkspaceInvite, type ChatEvent, type CopilotMode } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { sdk } from "@chiefbot/worker/fake-copilot";
import { startFakeMcpServer } from "./connectors/fakeMcpServer.ts";
import type { CopilotTokenMinter } from "./copilotIdentity.ts";
import { atCleanUp, cleanUp, doneCount, startTestControl, type TestUser } from "./testControl.ts";

afterEach(() => {
  cleanUp();
  setSystemTime();
});

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: { plan: "business", sku: "copilot_for_business_seat" } };
const minute = 60_000;

// A fake of GitHub's Copilot token minting: ghs_org_1, ghs_org_2… each living
// an hour, or always `refusal` when given. Records the repo of each mint.
function fakeMinter({ refusal }: { refusal?: string } = {}) {
  const minted: string[] = [];
  const mint: CopilotTokenMinter = async (repo) => {
    if (refusal !== undefined) return { error: refusal };
    minted.push(repo);
    return { token: `ghs_org_${minted.length}`, expiresAt: Date.now() + 60 * minute, account: repo.split("/")[0] ?? repo };
  };
  return { minted, mint };
}

// A workspace in `mode` owned by the signed-in user, with octo-friend as a
// member and a project for octo-org/shop whose coordinator is online. The
// workspace's connectors are defined by `before`, ahead of the project.
async function team(mode: CopilotMode, minter = fakeMinter(), { projectFile = "", before = async (_owner: TestUser, _workspace: Workspace) => {} } = {}) {
  const control = await startTestControl({ copilotTokens: minter.mint });
  const owner = control.user;
  const workspace = Workspace.parse(await (await owner.api("POST", "/workspaces", { name: "Platform team" })).json());
  await owner.api("PUT", `/workspaces/${workspace.id}/copilot-mode`, { mode });
  await owner.api("POST", `/workspaces/${workspace.id}/invites`, { login: friend.login });
  const guest = await control.signIn(friend);
  const [invite] = WorkspaceInvite.array().parse(await (await guest.api("GET", "/invites")).json());
  await guest.api("POST", `/invites/${invite?.id}/accept`);
  await before(owner, workspace);
  control.github.createRepo("octo-org/shop", { "chiefbot.project.yaml": projectFile });
  const project = Project.parse(await (await owner.api("POST", `/workspaces/${workspace.id}/projects`, { repo: "octo-org/shop" })).json());
  const coordinatorAuth = { authorization: `Bearer ${control.computers.computers.get(project.id)?.spec.env.CHIEFBOT_PROJECT_TOKEN}` };
  return { ...control, owner, guest, workspace, project, minter, coordinatorAuth };
}

// Sends a member's message to the coordinator and resolves with their chat once it is answered.
async function ask(member: TestUser, project: Project, text: string, turns = 1) {
  const chat = member.watchProjectChat(project.id);
  const res = await member.api("POST", `/projects/${project.id}/messages`, { text });
  if (res.status !== 202) throw new Error(`ask failed: ${res.status} ${await res.text()}`);
  return chat.until(doneCount(turns));
}

const payers = (events: ChatEvent[]) => events.flatMap(({ event }) => (event.type === "payer" ? [event.payer] : []));

test("without org billing, a coordinator turn runs on the seat of the member who asked, and the chat says so", async () => {
  const { guest, project, copilot, minter } = await team("personal");

  const chat = await ask(guest, project, "plan the checkout");

  const guestId = User.parse(await (await guest.api("GET", "/me")).json()).id;
  expect(payers(chat)).toEqual([{ kind: "seat", userId: guestId, login: "octo-friend" }]);
  expect(copilot.tokens).toEqual([guest.tokens.accessToken]);
  expect(minter.minted).toEqual([]);
});

test("with org billing, a coordinator turn runs on the organization's token, and no member's seat is handed out", async () => {
  const { url, guest, project, copilot, minter, coordinatorAuth } = await team("org");
  const seatAsked: number[] = [];
  const guestId = User.parse(await (await guest.api("GET", "/me")).json()).id;
  copilot.script = async function* () {
    seatAsked.push((await fetch(`${url}/coordinator/${project.id}/github-token/${guestId}`, { headers: coordinatorAuth })).status);
    yield sdk.idle();
  };

  const chat = await ask(guest, project, "plan the checkout");

  expect(payers(chat)).toEqual([{ kind: "org", account: "octo-org" }]);
  expect(copilot.tokens).toEqual(["ghs_org_1"]);
  expect(minter.minted).toEqual(["octo-org/shop"]);
  expect(seatAsked).toEqual([404]);
  // Outside a turn, the organization's token is not handed out either.
  expect((await fetch(`${url}/coordinator/${project.id}/installation-token`, { headers: coordinatorAuth })).status).toBe(404);
});

test("an hour on, a new organization token restarts the coordinator's runtime and resumes the same session", async () => {
  const { guest, project, copilot } = await team("org");
  await ask(guest, project, "first");

  // 50 minutes later the first token has too little left for a turn.
  setSystemTime(Date.now() + 50 * minute);
  const chat = await ask(guest, project, "second", 2);

  expect(copilot.tokens).toEqual(["ghs_org_1", "ghs_org_2"]);
  const sessionId = copilot.sessionIds[0] ?? "";
  expect(copilot.sessionIds).toEqual([sessionId, sessionId]);
  expect(copilot.closed).toEqual([sessionId]);
  expect(copilot.sends.map(({ sessionId, prompt }) => [sessionId, prompt])).toEqual([
    [sessionId, "first"],
    [sessionId, "second"],
  ]);
  expect(chat.filter(({ event }) => event.type === "error")).toEqual([]);
});

test("a token with time left is kept: the runtime is not restarted between turns", async () => {
  const { guest, project, copilot } = await team("org");

  await ask(guest, project, "first");
  setSystemTime(Date.now() + 30 * minute);
  await ask(guest, project, "second", 2);

  expect(copilot.tokens).toEqual(["ghs_org_1"]);
  expect(copilot.closed).toEqual([]);
});

test("switching the workspace to org billing moves the member's next turn onto the organization, in the same session", async () => {
  const { owner, guest, workspace, project, copilot } = await team("personal");
  await ask(guest, project, "on my seat");

  await owner.api("PUT", `/workspaces/${workspace.id}/copilot-mode`, { mode: "org" });
  const chat = await ask(guest, project, "on the org", 2);

  expect(payers(chat).map(({ kind }) => kind)).toEqual(["seat", "org"]);
  expect(copilot.tokens).toEqual([guest.tokens.accessToken, "ghs_org_1"]);
  expect(new Set(copilot.sessionIds).size).toBe(1);
  expect(copilot.closed).toHaveLength(1);
});

test("when GitHub will not mint the organization's token, the turn fails with what to fix", async () => {
  const minter = fakeMinter({ refusal: "Chiefbot's repo app needs the Copilot Requests permission" });
  const { guest, project, copilot } = await team("org", minter);

  const chat = await ask(guest, project, "plan the checkout");

  expect(chat.map(({ event }) => event).filter(({ type }) => type === "error")).toEqual([
    { type: "error", message: "Chiefbot's repo app needs the Copilot Requests permission" },
  ]);
  expect(copilot.sends).toEqual([]);
});

test("with org billing, a member's personal connector still acts as that member, also after the token renews", async () => {
  const upstream = startFakeMcpServer();
  atCleanUp(upstream.stop);
  const { guest, project, copilot } = await team("org", fakeMinter(), {
    projectFile: "connectors: [tracker]\n",
    before: async (owner, workspace) => {
      const tracker = { name: "tracker", title: "Tracker", server: { kind: "remote", url: upstream.url }, auth: "personal-oauth", scope: "" };
      await owner.api("POST", `/workspaces/${workspace.id}/connectors`, tracker);
    },
  });
  await guest.api("PUT", `/workspaces/${project.workspaceId}/connectors/tracker/token`, { token: "tracker-guest" });
  copilot.script = async function* (_prompt, runtime) {
    await runtime.callMcp("tracker", "list_issues");
    yield sdk.idle();
  };

  await ask(guest, project, "status?");
  setSystemTime(Date.now() + 50 * minute);
  await ask(guest, project, "status again?", 2);

  // Copilot ran on the organization's tokens, renewed once; the tracker on the member's own.
  expect(copilot.tokens).toEqual(["ghs_org_1", "ghs_org_2"]);
  expect(copilot.mcpServers.map((servers) => Object.keys(servers ?? {}))).toEqual([["tracker"], ["tracker"]]);
  expect(upstream.calls).toEqual([
    { tool: "list_issues", authorization: "Bearer tracker-guest" },
    { tool: "list_issues", authorization: "Bearer tracker-guest" },
  ]);
  const log = ConnectorCall.array().parse(await (await guest.api("GET", `/projects/${project.id}/connector-calls`)).json());
  expect(log.map(({ requester, identity }) => [requester, identity])).toEqual([
    ["octo-friend", "personal"],
    ["octo-friend", "personal"],
  ]);
});
