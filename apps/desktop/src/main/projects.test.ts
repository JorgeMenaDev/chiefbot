import { afterEach, expect, test } from "bun:test";
import { SignInResponse, Workspace, type ProjectChatView, type ProjectId, type Task } from "@chiefbot/contracts";
import { startControl } from "@chiefbot/control";
import { fakeComputers } from "@chiefbot/control/fake-computers";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { fakeCopilot, sdk } from "@chiefbot/worker/fake-copilot";
import { createBots } from "./bots.ts";
import { createProjects } from "./projects.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

test("a member creates a project from a repo, chats with its coordinator and sees the ledger it keeps", async () => {
  const github = startFakeGitHub();
  // The coordinator files each request as a task.
  const copilot = fakeCopilot({
    script: async function* (prompt, runtime) {
      await runtime.tool("create_task", { title: prompt });
      yield sdk.message("msg-1", "Filed it.");
      yield sdk.idle();
    },
  });
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
  github.createRepo("octo-org/notes", { "README.md": "# Notes" });
  github.createRepo("octo-org/shop", { "chiefbot.project.yaml": "commands:\n  test: bun test\n" });

  // The desktop: its projects, and its /events socket for live ledgers.
  let changed = () => {};
  const ledgers: Array<{ projectId: ProjectId; tasks: Task[] }> = [];
  const projects = createProjects({ controlUrl: control.url, session: () => sessionToken, retryMs: 20, onChat: () => changed() });
  const bots = createBots({
    controlUrl: control.url,
    session: () => sessionToken,
    onChange: () => {},
    onTasks: (projectId, tasks) => ledgers.push({ projectId, tasks }),
  });
  stops.push(projects.disconnect, bots.disconnect);
  bots.connect();
  const until = (projectId: ProjectId, matches: (view: ProjectChatView) => boolean) =>
    new Promise<ProjectChatView>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`chat never matched: ${JSON.stringify(projects.chatView(projectId))}`)), 2000);
      changed = () => {
        if (!matches(projects.chatView(projectId))) return;
        clearTimeout(timer);
        resolve(projects.chatView(projectId));
      };
      changed();
    });

  await expect(projects.create(team.id, "octo-org/notes")).rejects.toThrow("invalid_project_file: No chiefbot.project.yaml");
  const project = await projects.create(team.id, "octo-org/shop");
  expect(await projects.list(team.id)).toEqual([project]);
  expect(project.file.commands).toEqual({ test: "bun test" });

  projects.openChat(project.id);
  await projects.send(project.id, "Add dark mode");
  const view = await until(project.id, (view) => view.working === null && view.items.length >= 3);

  // The member's own seat pays for the turn, and the chat says so.
  expect(view.items.map((item) => (item.kind === "user" || item.kind === "assistant" ? item.text : item.kind))).toEqual([
    "Add dark mode",
    "payer",
    "Filed it.",
  ]);
  expect(view.items[1]).toMatchObject({ kind: "payer", payer: { kind: "seat", login: "octo-user" } });
  const ledger = await projects.tasks(project.id);
  expect(ledger.map(({ number, title, status }) => [number, title, status])).toEqual([[1, "Add dark mode", "open"]]);
  for (let wait = 0; ledgers.length === 0 && wait < 200; wait++) await Bun.sleep(10);
  expect(ledgers).toEqual([{ projectId: project.id, tasks: ledger }]);
});
