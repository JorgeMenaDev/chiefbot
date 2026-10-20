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

  // A repo with no project file makes a project too: it then uses its settings alone.
  const notes = await projects.create(team.id, "octo-org/notes");
  expect(notes.file).toEqual({ status: "missing" });
  await expect(projects.create(team.id, "octo-org/nowhere")).rejects.toThrow("repo_not_found");
  const project = await projects.create(team.id, "octo-org/shop");
  expect(await projects.list(team.id)).toEqual([notes, project]);
  expect(project.config.commands).toEqual({ test: "bun test" });

  projects.openChat(project.id);
  await projects.send(project.id, "Add dark mode");
  const view = await until(project.id, (view) => view.working === null && view.items.length >= 4);

  // The member's own seat pays for the turn, and the chat says so.
  expect(view.items.map((item) => (item.kind === "user" || item.kind === "assistant" ? item.text : item.kind))).toEqual([
    "Add dark mode",
    "payer",
    "tool",
    "Filed it.",
  ]);
  // The coordinator fetched the repo's default branch first.
  expect(view.items[2]).toMatchObject({ kind: "tool", name: "Fetch octo-org/shop", status: "succeeded" });
  expect(view.items[1]).toMatchObject({ kind: "payer", payer: { kind: "seat", login: "octo-user" } });
  const ledger = await projects.tasks(project.id);
  expect(ledger.map(({ number, title, status }) => [number, title, status])).toEqual([[1, "Add dark mode", "open"]]);
  for (let wait = 0; ledgers.length === 0 && wait < 200; wait++) await Bun.sleep(10);
  expect(ledgers).toEqual([{ projectId: project.id, tasks: ledger }]);
});

// Control with a fake GitHub and fake computers, the fake's user signed in with
// a workspace, and the desktop's projects as Electron main keeps them.
async function signedIn() {
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
  const headers = { authorization: `Bearer ${sessionToken}` };
  const team = Workspace.parse(await (await fetch(`${control.url}/workspaces`, { method: "POST", headers, body: '{"name":"Platform team"}' })).json());
  const projects = createProjects({ controlUrl: control.url, session: () => sessionToken, onChat: () => {} });
  stops.push(projects.disconnect);
  return { github, team, projects };
}

test("a member adds and removes what a project listens to, and sees control's refusals", async () => {
  const { github, team, projects } = await signedIn();
  github.createRepo("octo-org/shop", { "chiefbot.project.yaml": "connectors: [github-actions]\n" });
  const project = await projects.create(team.id, "octo-org/shop");

  const added = await projects.subscribe(project.id, { kind: "schedule", prompt: "Triage new bugs", cron: "0 9 * * 1-5", timezone: "Europe/London" });
  const listed = await projects.subscriptions(project.id);
  await projects.unsubscribe(project.id, added.id);

  expect(listed).toEqual([added]);
  expect(added).toMatchObject({ addedBy: "octo-user", events: 0, lastPolledAt: null });
  expect(await projects.subscriptions(project.id)).toEqual([]);
  await expect(projects.subscribe(project.id, { kind: "ci-status", connector: "github-actions", branch: "main", intervalSeconds: 300 })).rejects.toThrow(
    "invalid_subscription",
  );
});

test("a member saves a project's settings and sets and clears its secrets, whose values never come back", async () => {
  const { github, team, projects } = await signedIn();
  github.createRepo("octo-org/shop", { "README.md": "# Shop" });
  const project = await projects.create(team.id, "octo-org/shop");

  const saved = await projects.saveSettings(project.id, "secrets: [API_KEY]\ncommands:\n  setup: bun install\n");
  await projects.setSecret(project.id, "API_KEY", "sk-desktop-value");
  const set = await projects.secrets(project.id);
  await projects.clearSecret(project.id, "API_KEY");

  expect([saved.config.commands, saved.sources]).toEqual([{ setup: "bun install" }, { secrets: "settings", "commands.setup": "settings" }]);
  expect(set).toEqual([{ name: "API_KEY", declared: true, set: true }]);
  expect(await projects.secrets(project.id)).toEqual([{ name: "API_KEY", declared: true, set: false }]);
  await expect(projects.saveSettings(project.id, "workers:\n  max: 0\n")).rejects.toThrow("invalid_settings: Settings: workers.max");
  await expect(projects.setSecret(project.id, "OTHER_KEY", "x")).rejects.toThrow("invalid_secret");
});

test("a member picks the model the project's coordinator runs on, among those their plan offers", async () => {
  const { github, team, projects } = await signedIn();
  github.createRepo("octo-org/shop", { "README.md": "# Shop" });
  const project = await projects.create(team.id, "octo-org/shop");

  const picked = await projects.setModel(project.id, { model: "auto", effort: null });

  expect([project.model, picked.model, picked.effort]).toEqual(["auto", "auto", null]);
  // The fake's user is on Copilot Free, which offers only Auto.
  await expect(projects.setModel(project.id, { model: "gpt-6.1-sol" })).rejects.toThrow("model_unavailable");
});
