import { afterEach, expect, test } from "bun:test";
import { Project, SignInResponse, Workspace, type ProjectId, type ProjectState } from "@chiefbot/contracts";
import { startControl } from "@chiefbot/control";
import { fakeComputers } from "@chiefbot/control/fake-computers";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { fakeCopilot, type FakeCopilot } from "@chiefbot/worker/fake-copilot";
import { createBots } from "./bots.ts";
import { createProjects } from "./projects.ts";

// What Electron main fetches and follows for the Projects tab, against control
// with a fake GitHub and fake computers.

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

// Control, the fake GitHub's user signed in, and their project for octo-org/shop.
async function projectControl(copilot: FakeCopilot = fakeCopilot()) {
  const github = startFakeGitHub();
  const computers = fakeComputers({ copilot });
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, githubClientId: "test-client", githubApp: github.app, computers: computers.provider });
  stops.push(github.stop, computers.stopAll, control.stop);
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({ accessToken, accessTokenExpiresAt: Date.now() + 8 * 3600_000, refreshToken, refreshTokenExpiresAt: 0 }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  const headers = { authorization: `Bearer ${sessionToken}` };
  const team = Workspace.parse(await (await fetch(`${control.url}/workspaces`, { method: "POST", headers, body: '{"name":"Platform team"}' })).json());
  github.createRepo("octo-org/shop", { "README.md": "# Shop" });
  const project = Project.parse(
    await (await fetch(`${control.url}/workspaces/${team.id}/projects`, { method: "POST", headers, body: '{"repo":"octo-org/shop"}' })).json(),
  );
  const session = () => sessionToken;
  return { control, computers, headers, project, session };
}

// Resolves once check passes, failing after two seconds.
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await Bun.sleep(10);
  }
}

test("each project's state reaches main live, and main keeps the latest for a window that opens later", async () => {
  const { control, project, session } = await projectControl();
  const states: Array<[ProjectId, ProjectState]> = [];
  const bots = createBots({ controlUrl: control.url, session, onChange: () => {}, onProjectState: (projectId, state) => states.push([projectId, state]) });
  stops.push(bots.disconnect);

  bots.connect();

  await eventually(() => bots.projectStates()[project.id] === "idle");
  expect(states.at(-1)).toEqual([project.id, "idle"]);
});
