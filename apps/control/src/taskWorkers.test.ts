import { afterEach, expect, test } from "bun:test";
import { ApiError, ConnectorCall, Project, Task, TaskWorker, User, Workspace, WorkspaceInvite } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { fakeCopilot, sdk, type FakeCopilot, type FakeScript } from "@chiefbot/worker/fake-copilot";
import { gitProxyConfig } from "@chiefbot/worker/git-proxy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "@chiefbot/worker/clock";
import { startFakeMcpServer } from "./connectors/fakeMcpServer.ts";
import { atCleanUp, cleanUp, doneCount, eventually, fakeCoordinator, startTestControl, type TestControlOptions, type TestUser } from "./testControl.ts";

// A project's workers end to end: the coordinator (fake Copilot) dispatches a
// task through its tools, control writes a launch record and makes a fake
// computer, whose worker runs the task on the same fake Copilot. Every script
// tells the coordinator's prompts from a worker's by the worker's task line.

afterEach(cleanUp);

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } };

// Control with a workspace owned by the signed-in user, octo-friend as its
// member (both may write to the repo), and a project for octo-org/shop whose
// coordinator is online. `projectFile` is the repo's chiefbot.project.yaml.
async function teamProject(options: TestControlOptions = {}, projectFile = "commands:\n  test: bun test\n") {
  const control = await startTestControl(options);
  const owner = control.user;
  const workspace = Workspace.parse(await (await owner.api("POST", "/workspaces", { name: "Platform team" })).json());
  await owner.api("POST", `/workspaces/${workspace.id}/invites`, { login: friend.login });
  const guest = await control.signIn(friend);
  const [invite] = WorkspaceInvite.array().parse(await (await guest.api("GET", "/invites")).json());
  await guest.api("POST", `/invites/${invite?.id}/accept`);
  control.github.createRepo(
    "octo-org/shop",
    { "chiefbot.project.yaml": projectFile, "README.md": "# Shop\nTeh shop.\n" },
    { access: { "octo-user": "write", "octo-friend": "write" } },
  );
  const project = Project.parse(await (await owner.api("POST", `/workspaces/${workspace.id}/projects`, { repo: "octo-org/shop" })).json());
  return { ...control, owner, guest, workspace, project };
}

// Sends a member's message to the project's coordinator and waits until it is answered.
async function ask(member: TestUser, project: Project, text: string, turns = 1) {
  const chat = member.watchProjectChat(project.id);
  const res = await member.api("POST", `/projects/${project.id}/messages`, { text });
  if (res.status !== 202) throw new Error(`ask failed: ${res.status} ${await res.text()}`);
  await chat.until(doneCount(turns));
}

const isWorker = (prompt: string) => /^Task #\d+:/m.test(prompt);

// What a fake coordinator tool call answered: its JSON, or the refusal's message.
const answer = (call: Promise<{ result: unknown }>) =>
  call.then(
    ({ result }): unknown => JSON.parse(String(result)),
    (error: Error) => ({ refused: error.message }),
  );

const workersOf = async (member: TestUser, project: Project) =>
  TaskWorker.array().parse(await (await member.api("GET", `/projects/${project.id}/workers`)).json());

// Waits until the project's worker `id` matches, then returns it.
async function workerWhen(member: TestUser, project: Project, id: string, matches: (worker: TaskWorker) => boolean) {
  let found: TaskWorker | undefined;
  await eventually(async () => {
    found = (await workersOf(member, project)).find((worker) => worker.id === id);
    return found !== undefined && matches(found);
  });
  if (!found) throw new Error("unreachable");
  return found;
}

test("the coordinator dispatches a task: a worker gets its own computer and does the task on the requester's Copilot seat", async () => {
  const { owner, guest, project, copilot, computers } = await teamProject();
  const dispatched: unknown[] = [];
  copilot.script = async function* (prompt, runtime) {
    if (isWorker(prompt)) {
      yield sdk.message("msg-1", "Added the checkout page.");
      yield sdk.idle();
      return;
    }
    await runtime.tool("create_task", { title: "Add a checkout page", detail: "From cart to payment" });
    dispatched.push(await answer(runtime.tool("dispatch_worker", { task: 1, instructions: "Keep it small" })));
    yield sdk.idle();
  };

  await ask(guest, project, "Build the checkout page");

  const worker = TaskWorker.parse(dispatched[0]);
  expect(worker).toMatchObject({ projectId: project.id, taskNumber: 1, requestedBy: "octo-friend" });
  const finished = await workerWhen(owner, project, worker.id, ({ state }) => state === "finished");
  expect(finished).toMatchObject({ result: "Added the checkout page.", computerRemoved: false, pullRequest: null });
  // Its turn is over: the computer stops at once but keeps its disk until the task closes.
  await eventually(async () => (await computers.provider.status(worker.id)) === "stopped");
  expect(computers.destroyed).toEqual([]);
  const prompt = copilot.sends.find(({ sessionId }) => sessionId === worker.id)?.prompt ?? "";
  expect(prompt).toContain("Task #1: Add a checkout page\nFrom cart to payment");
  expect(prompt).toContain("Keep it small");
  // The coordinator's session and the worker's both run on octo-friend's seat.
  expect(copilot.tokens).toEqual([guest.tokens.accessToken, guest.tokens.accessToken]);
});

// A worker that never finishes.
const forever: FakeScript = async function* () {
  await new Promise(() => {});
};

// A fake coordinator takes the project's (fakeCoordinator) and holds the owner's
// turn open, after making task #1, so the test calls the coordinator's tools
// straight on control with that turn's key, as the coordinator does. `release`
// ends the turn. Workers run `worker` on the fake Copilot.
async function heldTurn(control: Awaited<ReturnType<typeof teamProject>>, worker: FakeScript = forever) {
  const { url, project, copilot, owner } = control;
  copilot.script = worker;
  const coordinator = await fakeCoordinator(control, project.id);
  coordinator.hello(null);
  const res = await owner.api("POST", `/projects/${project.id}/messages`, { text: "Fix the typo" });
  if (res.status !== 202) throw new Error(`ask failed: ${res.status}`);
  const { turnId, turnKey } = await coordinator.nth("run-turn");
  const tool = async (call: Record<string, unknown>) => {
    const answer = await fetch(`${url}/coordinator/${project.id}/tools`, { method: "POST", headers: { authorization: `Bearer ${turnKey}` }, body: JSON.stringify(call) });
    return { status: answer.status, body: (await answer.json()) as unknown };
  };
  await tool({ tool: "create_task", title: "Fix the typo" });
  return { tool, release: () => coordinator.event(turnId, { type: "done" }) };
}

// The key of the worker's turn, as its session's connector `name` carries it.
const workerKey = (copilot: FakeCopilot, name: string) => {
  const server = copilot.mcpServers.at(-1)?.[name];
  return server?.type === "http" ? (server.headers?.authorization ?? "") : "";
};

test("a resent dispatch with the same creation id starts one worker, even while the first is still getting its computer", async () => {
  const creates: string[] = [];
  let openGate = () => {};
  const gate = new Promise<void>((resolve) => (openGate = resolve));
  const control = await teamProject({
    provider: (fake) => ({
      ...fake,
      async create(spec) {
        if (spec.id.startsWith("worker_")) {
          creates.push(spec.id);
          await gate;
        }
        await fake.create(spec);
      },
    }),
  });
  const { tool } = await heldTurn(control);
  const dispatch = { tool: "dispatch_worker", task: 1, creationId: "session/call-7" };

  const first = tool(dispatch);
  const resent = tool(dispatch);
  await eventually(() => creates.length === 1);
  openGate();
  const [a, b] = await Promise.all([first, resent]);
  const later = await tool(dispatch);

  const id = TaskWorker.parse(a.body).id;
  expect([b, later].map(({ body }) => TaskWorker.parse(body).id)).toEqual([id, id]);
  expect(creates).toEqual([id]);
  expect(await workersOf(control.owner, control.project)).toHaveLength(1);
  // Another dispatch of the same task waits until that worker is done.
  const another = await tool({ ...dispatch, creationId: "session/call-8" });
  expect(another).toEqual({ status: 409, body: { error: "invalid_tool_call", message: `Worker ${id} still works on task #1: stop it first, or wait for it` } });
});

// A team project whose workers' fake Copilot runs real git in a temp workspace,
// reaching GitHub only through control's git proxy with the worker's credential,
// as in a worker's computer (see repo.test.ts).
async function gitTeamProject() {
  const workspace = mkdtempSync(join(tmpdir(), "chiefbot-worker-"));
  atCleanUp(() => rmSync(workspace, { recursive: true, force: true }));
  // Short: a unix socket path must fit in about 100 bytes.
  const socket = `/tmp/chiefbot-t17-${crypto.randomUUID().slice(0, 8)}.sock`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: workspace,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Chiefbot",
    GIT_AUTHOR_EMAIL: "chiefbot@example.com",
    GIT_COMMITTER_NAME: "Chiefbot",
    GIT_COMMITTER_EMAIL: "chiefbot@example.com",
    CHIEFBOT_GIT_SOCKET: socket,
  };
  const control = await teamProject({ copilot: fakeCopilot({ shell: { cwd: workspace, env } }), gitSocket: socket });
  const helper = join(import.meta.dir, "../../worker/src/gitCredential.ts");
  Object.assign(env, gitProxyConfig({ controlUrl: control.url, helper: `"${process.execPath}" ${helper}`, githubUrl: control.github.url }));
  return control;
}

test("the worker pushes and opens its pull request through control, each approved by the member who asked, and the task links it", async () => {
  const { owner, guest, project, copilot, github } = await gitTeamProject();
  const exitCodes: number[] = [];
  let dispatched: unknown = null;
  copilot.script = async function* (prompt, runtime) {
    if (isWorker(prompt)) {
      exitCodes.push((await runtime.shell(`git clone -q ${github.url}/octo-org/shop.git shop`)).exitCode);
      const fix = "cd shop && git checkout -q -b fix-typo && sed -i.bak 's/Teh/The/' README.md && rm README.md.bak && git commit -q -am 'Fix a typo'";
      exitCodes.push((await runtime.shell(`${fix} && git push -q -u origin fix-typo`)).exitCode);
      await runtime.tool("create_pull_request", { repository: "octo-org/shop", head: "fix-typo", base: "main", title: "Fix a typo" });
      yield sdk.message("msg-1", "Fixed the typo in pull request #1.");
      yield sdk.idle();
      return;
    }
    await runtime.tool("create_task", { title: "Fix the typo in the README" });
    dispatched = await answer(runtime.tool("dispatch_worker", { task: 1 }));
    yield sdk.idle();
  };
  await ask(guest, project, "Fix the typo in the README");
  const { id } = TaskWorker.parse(dispatched);
  const answerAs = (member: TestUser, approvalId: string, approved: boolean) =>
    member.api("POST", `/projects/${project.id}/workers/${id}/approvals/${approvalId}`, { approved });

  const push = (await workerWhen(owner, project, id, ({ pendingApprovals }) => pendingApprovals.length === 1)).pendingApprovals[0];
  expect(push).toMatchObject({ kind: "push", detail: "git push to octo-org/shop: fix-typo" });
  const byOwner = await answerAs(owner, push?.approvalId ?? "", true);
  expect([byOwner.status, ApiError.parse(await byOwner.json()).error]).toEqual([403, "requester_only"]);
  expect(github.pushes).toEqual([]);
  expect((await answerAs(guest, push?.approvalId ?? "", true)).status).toBe(204);
  const pr = (await workerWhen(owner, project, id, ({ pendingApprovals }) => pendingApprovals[0]?.kind === "pull-request")).pendingApprovals[0];
  expect(github.pullRequests).toEqual([]);
  await answerAs(guest, pr?.approvalId ?? "", true);

  const finished = await workerWhen(owner, project, id, ({ state }) => state === "finished");
  const url = `${github.url}/octo-org/shop/pull/1`;
  expect(finished).toMatchObject({ result: "Fixed the typo in pull request #1.", pullRequest: url, pendingApprovals: [] });
  expect(exitCodes).toEqual([0, 0]);
  expect(github.git("octo-org/shop", "show", "fix-typo:README.md")).toBe("# Shop\nThe shop.");
  expect(github.pushes).toEqual([{ repository: "octo-org/shop", by: "app" }]);
  expect(github.pullRequests).toMatchObject([{ repository: "octo-org/shop", head: "fix-typo", base: "main", by: "app" }]);
  const [task] = Task.array().parse(await (await owner.api("GET", `/projects/${project.id}/tasks`)).json());
  expect(task?.links).toEqual([{ kind: "pull-request", url }]);
});

test("the coordinator reads a worker's transcript and stops it: its turn ends and its computer is removed", async () => {
  const control = await teamProject();
  const { owner, project, computers } = control;
  const { tool } = await heldTurn(control, async function* () {
    yield sdk.toolStart("tool-1", "bash", "Run the tests");
    yield sdk.toolComplete("tool-1", false);
    yield sdk.delta("msg-1", "The tests ");
    yield sdk.delta("msg-1", "fail before my change.");
    await new Promise(() => {});
  });
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  const read = async (lines?: number) => (await tool({ tool: "worker_transcript", worker: id, ...(lines ? { lines } : {}) })).body;
  await eventually(async () => JSON.stringify(await read()).includes("fail before my change."));

  expect(await read()).toEqual({ worker: id, lines: ["tool Run the tests: failed", "worker: The tests fail before my change."], truncated: false });
  expect(await read(1)).toEqual({ worker: id, lines: ["worker: The tests fail before my change."], truncated: true });
  expect(TaskWorker.parse((await tool({ tool: "worker_status", worker: id })).body).state).toBe("working");

  const stopped = await tool({ tool: "stop_worker", worker: id });

  expect(TaskWorker.parse(stopped.body)).toMatchObject({ state: "stopped", result: "The coordinator stopped this worker." });
  await workerWhen(owner, project, id, ({ computerRemoved }) => computerRemoved);
  expect(computers.destroyed).toEqual([{ id, deleteData: true }]);
  expect((await read()) as unknown).toMatchObject({ lines: ["tool Run the tests: failed", "worker: The tests fail before my change.", "error: The coordinator stopped this worker."] });
  expect(await tool({ tool: "worker_status", worker: "worker_missing" })).toEqual({
    status: 404,
    body: { error: "invalid_tool_call", message: "No worker worker_missing in this project" },
  });
});

test("a task marked done or abandoned stops its worker and removes its computer", async () => {
  const control = await teamProject();
  const { owner, project, computers } = control;
  // The worker of task #1 finishes; the one of task #2 is still working when its task is dropped.
  const { tool } = await heldTurn(control, async function* (prompt) {
    if (prompt.includes("Task #2:")) await new Promise(() => {});
    yield sdk.message("msg-1", "Done.");
    yield sdk.idle();
  });
  await tool({ tool: "create_task", title: "Add dark mode" });
  const first = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  const second = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 2, creationId: "c-2" })).body);
  await workerWhen(owner, project, first.id, ({ state }) => state === "finished");
  await workerWhen(owner, project, second.id, ({ state }) => state === "working");
  expect(computers.destroyed).toEqual([]);

  await tool({ tool: "update_task", number: 1, status: "done" });
  await tool({ tool: "update_task", number: 2, status: "abandoned" });

  expect(await workerWhen(owner, project, first.id, ({ computerRemoved }) => computerRemoved)).toMatchObject({ state: "finished" });
  expect(await workerWhen(owner, project, second.id, ({ computerRemoved }) => computerRemoved)).toMatchObject({
    state: "stopped",
    result: "The task was closed.",
  });
  expect(computers.destroyed.map(({ id }) => id).sort()).toEqual([first.id, second.id].sort());
});

test("on restart control removes leaked worker computers and fails a launch the restart cut short", async () => {
  let destroyFails = false;
  let createHangs = false;
  const control = await teamProject({
    persistent: true,
    provider: (fake) => ({
      ...fake,
      async create(spec) {
        if (createHangs && spec.id.startsWith("worker_")) await new Promise(() => {});
        await fake.create(spec);
      },
      async destroy(id, options) {
        if (destroyFails && id.startsWith("worker_")) throw new Error("Docker is not answering");
        await fake.destroy(id, options);
      },
    }),
  });
  const { owner, project, computers } = control;
  const { tool, release } = await heldTurn(control);
  await tool({ tool: "create_task", title: "Add dark mode" });
  const leaked = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, leaked.id, ({ state }) => state === "working");
  // Closing the task cannot remove the computer: it leaks.
  destroyFails = true;
  await tool({ tool: "update_task", number: 1, status: "done" });
  await workerWhen(owner, project, leaked.id, ({ state }) => state === "stopped");
  // Control stops while it makes the next worker's computer.
  createHangs = true;
  void tool({ tool: "dispatch_worker", task: 2, creationId: "c-2" }).catch(() => {});
  let cut: TaskWorker | undefined;
  await eventually(async () => (cut = (await workersOf(owner, project)).find(({ taskNumber }) => taskNumber === 2)) !== undefined);
  release();

  destroyFails = false;
  control.restart();

  await workerWhen(owner, project, leaked.id, ({ computerRemoved }) => computerRemoved);
  const failed = await workerWhen(owner, project, cut?.id ?? "", ({ computerRemoved }) => computerRemoved);
  expect(failed).toMatchObject({ state: "failed", result: "Control restarted before its computer was ready." });
  expect(await computers.provider.status(leaked.id)).toBe("absent");
  expect(computers.destroyed.map(({ id }) => id).sort()).toEqual([leaked.id, failed.id].sort());
});

test("on restart control stops a finished worker's computer that failed to stop", async () => {
  let stopFails = true;
  const control = await teamProject({
    persistent: true,
    provider: (fake) => ({
      ...fake,
      async stop(id) {
        if (stopFails && id.startsWith("worker_")) throw new Error("Docker is not answering");
        await fake.stop(id);
      },
    }),
  });
  const { owner, project, computers } = control;
  const { tool, release } = await heldTurn(control, async function* () {
    yield sdk.message("msg-1", "Done.");
    yield sdk.idle();
  });
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, id, ({ state }) => state === "finished");
  await Bun.sleep(20);
  expect(await computers.provider.status(id)).toBe("running");
  release();

  stopFails = false;
  control.restart();

  await eventually(async () => (await computers.provider.status(id)) === "stopped");
  expect(computers.destroyed).toEqual([]);
});

test("a worker whose computer restarts mid-task fails, and deleting the project removes its computer", async () => {
  const control = await teamProject();
  const { owner, project, computers } = control;
  const { tool, release } = await heldTurn(control);
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, id, ({ state }) => state === "working");

  await computers.provider.stop(id);
  await computers.provider.start(id);

  expect(await workerWhen(owner, project, id, ({ state }) => state === "failed")).toMatchObject({
    result: "The worker's computer restarted before it finished the task.",
    computerRemoved: false,
  });
  await eventually(async () => (await computers.provider.status(id)) === "stopped");
  release();
  expect((await owner.api("DELETE", `/projects/${project.id}`)).status).toBe(204);
  expect(computers.destroyed).toEqual([
    { id, deleteData: true },
    { id: project.id, deleteData: true },
  ]);
});

test("a worker gets the project's connectors through control's proxy, and its calls run and are logged as the member who asked", async () => {
  const upstream = startFakeMcpServer();
  atCleanUp(upstream.stop);
  const { owner, guest, workspace, project, copilot } = await teamProject({}, "connectors: [tracker]\n");
  const connectors = `/workspaces/${workspace.id}/connectors`;
  await owner.api("POST", connectors, { name: "tracker", title: "Tracker", server: { kind: "remote", url: upstream.url }, auth: "personal-oauth", scope: "" });
  await guest.api("PUT", `${connectors}/tracker/token`, { token: "tracker-guest" });
  let dispatched: unknown = null;
  copilot.script = async function* (prompt, runtime) {
    if (isWorker(prompt)) {
      await runtime.callMcp("tracker", "list_issues");
      yield sdk.idle();
      return;
    }
    await runtime.tool("create_task", { title: "Triage the issues" });
    dispatched = await answer(runtime.tool("dispatch_worker", { task: 1 }));
    yield sdk.idle();
  };

  await ask(guest, project, "Triage the open issues");
  const { id } = TaskWorker.parse(dispatched);
  await workerWhen(owner, project, id, ({ state }) => state === "finished");

  // The worker's session reaches the connector through its own route on control.
  expect(copilot.mcpServers.at(-1)?.tracker).toMatchObject({ type: "http", url: expect.stringContaining(`/task-worker/${id}/mcp/tracker`) });
  expect(upstream.calls).toEqual([{ tool: "list_issues", authorization: "Bearer tracker-guest" }]);
  const log = ConnectorCall.array().parse(await (await owner.api("GET", `/projects/${project.id}/connector-calls`)).json());
  expect(log.map(({ connector, tool, requester, identity }) => [connector, tool, requester, identity])).toEqual([
    ["tracker", "list_issues", "octo-friend", "personal"],
  ]);
});

test("a worker's call to a connector tool that may write waits for the member who asked, asked once, by control", async () => {
  const upstream = startFakeMcpServer({ writes: ["create_issue"] });
  atCleanUp(upstream.stop);
  const { owner, guest, workspace, project, copilot } = await teamProject({}, "connectors: [tracker]\n");
  const connectors = `/workspaces/${workspace.id}/connectors`;
  await owner.api("POST", connectors, { name: "tracker", title: "Tracker", server: { kind: "remote", url: upstream.url }, auth: "personal-oauth", scope: "" });
  await guest.api("PUT", `${connectors}/tracker/token`, { token: "tracker-guest" });
  let dispatched: unknown = null;
  copilot.script = async function* (prompt, runtime) {
    if (isWorker(prompt)) {
      // The runtime knows the tool may write, as the server's annotations say.
      await runtime.callMcp("tracker", "create_issue", false);
      yield sdk.idle();
      return;
    }
    await runtime.tool("create_task", { title: "File the bug" });
    dispatched = await answer(runtime.tool("dispatch_worker", { task: 1 }));
    yield sdk.idle();
  };

  await ask(guest, project, "File the bug");
  const { id } = TaskWorker.parse(dispatched);
  const waiting = await workerWhen(owner, project, id, ({ pendingApprovals }) => pendingApprovals.length > 0);
  const held = upstream.calls.length;
  const [pending] = waiting.pendingApprovals;
  await guest.api("POST", `/projects/${project.id}/workers/${id}/approvals/${pending?.approvalId}`, { approved: true });

  await workerWhen(owner, project, id, ({ state }) => state === "finished");
  expect(waiting.pendingApprovals).toEqual([{ approvalId: expect.any(String), kind: "connector", detail: "Tracker: create_issue" }]);
  expect(held).toBe(0);
  expect(upstream.calls).toEqual([{ tool: "create_issue", authorization: "Bearer tracker-guest" }]);
});

test("a removed member loses everything at once: their project chat closes, their queued turns go, their workers stop and their turn keys stop working", async () => {
  const upstream = startFakeMcpServer();
  atCleanUp(upstream.stop);
  const control = await teamProject({}, "connectors: [tracker]\n");
  const { url, owner, guest, workspace, project, copilot, computers } = control;
  await owner.api("POST", `/workspaces/${workspace.id}/connectors`, { name: "tracker", title: "Tracker", server: { kind: "remote", url: upstream.url }, auth: "none", scope: "" });
  let release = () => {};
  let dispatched: unknown = null;
  copilot.script = async function* (prompt, runtime) {
    if (isWorker(prompt)) return yield* forever(prompt, runtime);
    if (prompt === "Hold on") await new Promise<void>((resolve) => (release = resolve));
    if (prompt === "Fix the typo") {
      await runtime.tool("create_task", { title: "Fix the typo" });
      dispatched = await answer(runtime.tool("dispatch_worker", { task: 1 }));
    }
    yield sdk.idle();
  };
  await ask(guest, project, "Fix the typo");
  const { id } = TaskWorker.parse(dispatched);
  await workerWhen(owner, project, id, ({ state }) => state === "working");
  const workerAuth = { authorization: workerKey(copilot, "tracker") };
  // The owner's turn runs; octo-friend's next message waits behind it.
  await owner.api("POST", `/projects/${project.id}/messages`, { text: "Hold on" });
  await eventually(() => copilot.sends.some(({ prompt }) => prompt === "Hold on"));
  await guest.api("POST", `/projects/${project.id}/messages`, { text: "Queued" });
  const guestChat = new WebSocket(`${url.replace("http", "ws")}/projects/${project.id}/chat`, { headers: guest.auth });
  atCleanUp(() => guestChat.close());
  await new Promise((resolve) => (guestChat.onopen = resolve));
  const chatClosed = new Promise((resolve) => (guestChat.onclose = resolve));
  const guestId = User.parse(await (await guest.api("GET", "/me")).json()).id;

  expect((await owner.api("DELETE", `/workspaces/${workspace.id}/members/${guestId}`)).status).toBe(204);

  await chatClosed;
  expect(await workerWhen(owner, project, id, ({ computerRemoved }) => computerRemoved)).toMatchObject({ state: "stopped" });
  const refused = await Promise.all([
    fetch(`${url}/task-worker/${id}/github-token`, { headers: workerAuth }),
    fetch(`${url}/task-worker/${id}/mcp/tracker`, { method: "POST", headers: workerAuth, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
    fetch(`${url}/task-worker/${id}/pull-requests`, { method: "POST", headers: workerAuth, body: "{}" }),
  ]);
  expect(refused.map(({ status }) => status)).toEqual([403, 403, 403]);
  release();
  await owner.watchProjectChat(project.id).until(doneCount(1));
  await Bun.sleep(50);
  expect(copilot.sends.map(({ prompt }) => prompt).filter((prompt) => !isWorker(prompt))).toEqual(["Fix the typo", "Hold on"]);
});

test("a worker waiting on an approval longer than the limit stops, keeping its disk, also when control restarts meanwhile", async () => {
  const time = fakeClock(Date.now());
  const control = await teamProject({ persistent: true, clock: time.clock });
  const { owner, project, computers } = control;
  const { tool, release } = await heldTurn(control, async function* (_prompt, runtime) {
    // A GitHub tool that writes: the worker asks the member who asked for it.
    await runtime.mcp("github", "Create issue", false);
    yield sdk.idle();
  });
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, id, ({ pendingApprovals }) => pendingApprovals.length === 1);
  release();

  time.advance(30 * 60_000);
  control.restart();
  await eventually(() => computers.computers.get(id)?.worker !== null);
  time.advance(29 * 60_000);
  await Bun.sleep(20);
  const before = (await workersOf(owner, project)).find((worker) => worker.id === id)?.state;
  time.advance(2 * 60_000);

  expect(before).toBe("working");
  expect(await workerWhen(owner, project, id, ({ state }) => state === "failed")).toMatchObject({
    result: "It waited over 60 minutes for octo-user to approve, so its computer stopped, keeping its disk. Dispatch the task again to retry.",
    pendingApprovals: [],
    computerRemoved: false,
  });
  await eventually(async () => (await computers.provider.status(id)) === "stopped");
  expect(computers.destroyed).toEqual([]);
});

test("an organization's worker whose turn is cut to renew its token withdraws the approval it waited on, so that approval's wait limit never stops it", async () => {
  const time = fakeClock(Date.now());
  let minted = 0;
  const control = await teamProject({
    clock: time.clock,
    copilotTokens: async (repo) => ({ token: `ghs_org_${++minted}`, expiresAt: time.clock.now() + 60 * 60_000, account: repo.split("/")[0] ?? repo }),
  });
  const { owner, workspace, project, copilot } = control;
  await owner.api("PUT", `/workspaces/${workspace.id}/copilot-mode`, { mode: "org" });
  // The task asks to write; continued on a new token, the agent asks again and waits.
  const asksToWrite: FakeScript = async function* (_prompt, runtime) {
    await runtime.mcp("github", "Create issue", false);
    yield sdk.idle();
  };
  const { tool } = await heldTurn(control, asksToWrite);
  const coordinatorOrTask = copilot.script;
  copilot.script = (prompt, runtime) => (prompt === "continue" ? asksToWrite(prompt, runtime) : coordinatorOrTask(prompt, runtime));
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  const [first] = (await workerWhen(owner, project, id, ({ pendingApprovals }) => pendingApprovals.length === 1)).pendingApprovals;

  // Five minutes before the token expires, the turn is cut and continues on a new one.
  time.advance(56 * 60_000);
  const [second] = (
    await workerWhen(owner, project, id, ({ pendingApprovals }) => pendingApprovals.length === 1 && pendingApprovals[0]?.approvalId !== first?.approvalId)
  ).pendingApprovals;
  // Past the first approval's wait limit, not the second's.
  time.advance(10 * 60_000);
  await Bun.sleep(20);

  expect(copilot.sends.filter(({ sessionId }) => sessionId === id).map(({ prompt }) => (isWorker(prompt) ? "the task" : prompt))).toEqual(["the task", "continue"]);
  expect((await workersOf(owner, project)).find((worker) => worker.id === id)).toMatchObject({ state: "working", pendingApprovals: [second] });
  expect((await owner.api("POST", `/projects/${project.id}/workers/${id}/approvals/${first?.approvalId}`, { approved: true })).status).toBe(409);
});

test("an approval control holds for a worker's request is withdrawn when that request goes away, as when its runtime is cut, so its wait limit never stops the worker", async () => {
  const upstream = startFakeMcpServer({ writes: ["create_issue"] });
  atCleanUp(upstream.stop);
  const time = fakeClock(Date.now());
  const control = await teamProject({ clock: time.clock }, "connectors: [tracker]\n");
  const { url, owner, workspace, project, copilot } = control;
  const connectors = `/workspaces/${workspace.id}/connectors`;
  await owner.api("POST", connectors, { name: "tracker", title: "Tracker", server: { kind: "remote", url: upstream.url }, auth: "personal-oauth", scope: "" });
  await owner.api("PUT", `${connectors}/tracker/token`, { token: "tracker-owner" });
  const { tool } = await heldTurn(control);
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, id, ({ state }) => state === "working");
  // The worker's runtime calls a tool that may write, then goes away before the answer.
  const hangUp = new AbortController();
  const call = fetch(`${url}/task-worker/${id}/mcp/tracker`, {
    method: "POST",
    headers: { authorization: workerKey(copilot, "tracker"), "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_issue" } }),
    signal: hangUp.signal,
  }).catch(() => null);
  const [asked] = (await workerWhen(owner, project, id, ({ pendingApprovals }) => pendingApprovals.length === 1)).pendingApprovals;
  hangUp.abort();
  await call;

  await workerWhen(owner, project, id, ({ pendingApprovals }) => pendingApprovals.length === 0);
  time.advance(61 * 60_000);
  await Bun.sleep(20);

  expect((await workersOf(owner, project)).find((worker) => worker.id === id)?.state).toBe("working");
  expect((await owner.api("POST", `/projects/${project.id}/workers/${id}/approvals/${asked?.approvalId}`, { approved: true })).status).toBe(409);
  expect(upstream.calls).toEqual([]);
});

test("when the organization pays, a worker runs on its installation token", async () => {
  let minted = 0;
  const control = await teamProject({
    copilotTokens: async (repo) => ({ token: `ghs_org_${++minted}`, expiresAt: Date.now() + 3600_000, account: repo.split("/")[0] ?? repo }),
  });
  const { owner, workspace, project, copilot } = control;
  await owner.api("PUT", `/workspaces/${workspace.id}/copilot-mode`, { mode: "org" });
  const { tool } = await heldTurn(control);
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);

  const working = await workerWhen(owner, project, id, ({ state }) => state === "working");
  expect(working.payer).toEqual({ kind: "org", account: "octo-org" });
  await eventually(() => copilot.sends.some(({ sessionId }) => sessionId === id));
  // The (fake) coordinator asked for none: the worker's session took the first.
  expect(copilot.tokens).toEqual(["ghs_org_1"]);
});
