import { afterEach, expect, test } from "bun:test";
import { ContextPath, Project, SignInResponse, Workspace, type ProjectStates, type WorkerChatView } from "@chiefbot/contracts";
import { startControl } from "@chiefbot/control";
import { fakeComputers } from "@chiefbot/control/fake-computers";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { fakeCopilot, sdk, type FakeCopilot } from "@chiefbot/worker/fake-copilot";
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

test("each project's state reaches main live, main keeps them for a window that opens later, and a deleted project's goes", async () => {
  const { control, headers, project, session } = await projectControl();
  const sent: ProjectStates[] = [];
  const bots = createBots({ controlUrl: control.url, session, onChange: () => {}, onProjectStates: (states) => sent.push(states) });
  stops.push(bots.disconnect);

  bots.connect();
  await eventually(() => bots.projectStates()[project.id] === "idle");
  expect(sent.at(-1)).toEqual({ [project.id]: "idle" });

  expect((await fetch(`${control.url}/projects/${project.id}`, { method: "DELETE", headers })).status).toBe(204);
  await eventually(() => bots.projectStates()[project.id] === undefined);
  expect(sent.at(-1)).toEqual({});
});

test("main follows one engineer's transcript at a time until the window leaves it, reads the shared context, and takes and hands back an engineer's screen", async () => {
  // The project agent files the request, notes it and starts an engineer, which says one thing and keeps working.
  const copilot = fakeCopilot({
    script: async function* (prompt, runtime) {
      if (/^Task #\d+:/m.test(prompt)) {
        yield sdk.message("msg-1", "Cloned the repo.");
        await new Promise(() => {});
      }
      await runtime.tool("create_task", { title: "Fix the typo" });
      await runtime.tool("write_context", { path: "notes.md", content: "Started task #1." });
      await runtime.tool("dispatch_worker", { task: 1 });
      yield sdk.idle();
    },
  });
  const { control, headers, project, session } = await projectControl(copilot);
  const views: WorkerChatView[] = [];
  const projects = createProjects({ controlUrl: control.url, session, retryMs: 20, onChat: () => {}, onWorkerChat: (view) => views.push(view) });
  stops.push(projects.disconnect);

  await projects.send(project.id, "Fix the typo");
  let engineers = await projects.workers(project.id);
  await eventually(async () => (engineers = await projects.workers(project.id)).some(({ state }) => state === "working"));
  const [engineer] = engineers;
  if (!engineer) throw new Error("no engineer");

  projects.openWorkerChat(project.id, engineer.id);
  const said = (view: WorkerChatView | undefined) => view?.items.some((item) => item.kind === "assistant" && item.text === "Cloned the repo.");
  await eventually(() => said(views.at(-1)) === true);
  expect(projects.workerChatView(engineer.id)).toEqual(views.at(-1) ?? { workerId: engineer.id, items: [], working: null });
  projects.closeWorkerChat(engineer.id);
  expect(projects.workerChatView(engineer.id)).toEqual({ workerId: engineer.id, items: [], working: null });

  expect((await projects.context(project.id)).map(({ path }) => String(path))).toEqual(["notes.md"]);
  expect(await projects.contextFile(project.id, "notes.md")).toEqual({ path: ContextPath.parse("notes.md"), content: "Started task #1." });

  // Control is taken from a view of the screen: the window's noVNC, here a bare socket.
  const screen = new WebSocket(`${control.url.replace("http", "ws")}/projects/${project.id}/workers/${engineer.id}/screen`, { headers });
  stops.push(() => screen.close());
  await new Promise((resolve) => (screen.onopen = resolve));
  expect((await projects.takeOver(project.id, engineer.id)).screenHolder).toBe("octo-user");
  expect((await projects.handBack(project.id, engineer.id)).screenHolder).toBeNull();
});
