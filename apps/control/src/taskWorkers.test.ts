import { afterEach, expect, test } from "bun:test";
import { ACCESS_MODES, ATTACHMENTS, ENGINEER_SETUP, ApiError, ConnectorCall, ContextFileText, Project, Task, TaskWorker, User, WorkerTranscript, Workspace, WorkspaceInvite } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { fakeCopilot, sdk, type FakeCopilot, type FakeScript } from "@chiefbot/worker/fake-copilot";
import { gitProxyConfig } from "@chiefbot/worker/git-proxy";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "@chiefbot/worker/clock";
import { setupShell, type SetupShell } from "@chiefbot/worker/engineer-setup";
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
// coordinator is online. `projectFile` is the repo's chiefbot.project.yaml, and `files` its other files.
async function teamProject(options: TestControlOptions = {}, projectFile = "commands:\n  test: bun test\n", files: Record<string, string> = {}) {
  const control = await startTestControl(options);
  const owner = control.user;
  const workspace = Workspace.parse(await (await owner.api("POST", "/workspaces", { name: "Platform team" })).json());
  await owner.api("POST", `/workspaces/${workspace.id}/invites`, { login: friend.login });
  const guest = await control.signIn(friend);
  const [invite] = WorkspaceInvite.array().parse(await (await guest.api("GET", "/invites")).json());
  await guest.api("POST", `/invites/${invite?.id}/accept`);
  control.github.createRepo(
    "octo-org/shop",
    { "chiefbot.project.yaml": projectFile, "README.md": "# Shop\nTeh shop.\n", ...files },
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

// How the latest session reaches its connector `name`: its computer's forwarder to control, with the turn's forwarder secret.
const connectorOf = (copilot: FakeCopilot, name: string) => {
  const server = copilot.mcpServers.at(-1)?.[name];
  return server?.type === "http" ? { url: server.url, headers: server.headers ?? {} } : { url: "", headers: {} };
};

// Connects to control as the worker `workerId` (with its credential `token`) and
// says hello, as a worker that can do `capabilities`. Every message control sends
// it is kept in `received`.
async function connectAsWorker(url: string, workerId: string, token: string, capabilities: string[]) {
  const received: string[] = [];
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/task-worker/${workerId}`, { headers: { authorization: `Bearer ${token}` } });
  socket.onmessage = (message) => received.push(String(message.data));
  await new Promise((resolve) => (socket.onopen = resolve));
  atCleanUp(() => socket.close());
  socket.send(JSON.stringify({ type: "hello", activeTurnId: null, capabilities }));
  return { received };
}

// How a fake setup command ends: its exit code and its output, in the chunks it comes in.
type SetupAnswer = { exitCode: number; output: string | string[] };

// An engineer's setup shell that runs nothing: each command answers as `answer`
// says (exit 0 and no output by default), and every run is recorded.
function fakeSetup(answer: (command: string) => SetupAnswer | Promise<SetupAnswer> = () => ({ exitCode: 0, output: "" })) {
  const runs: Array<{ command: string; cwd: string; env: Record<string, string> }> = [];
  const run: SetupShell = async (command, { cwd, env, onOutput }) => {
    runs.push({ command, cwd, env });
    const { exitCode, output } = await answer(command);
    for (const chunk of [output].flat()) onOutput(chunk);
    return exitCode;
  };
  return { runs, run };
}

test("an engineer sets up before its agent starts: it clones the repo and runs the setup command, and its transcript shows each with its exit code first", async () => {
  let install = () => {};
  const installed = new Promise<void>((resolve) => (install = resolve));
  const setup = fakeSetup(async (command) => {
    if (command !== "bun install") return { exitCode: 0, output: "" };
    await installed;
    return { exitCode: 0, output: "3 packages installed\n" };
  });
  const control = await teamProject({ setupShell: setup.run }, "commands:\n  setup: bun install\n");
  const { owner, project, copilot } = control;
  const { tool } = await heldTurn(control, async function* () {
    yield sdk.message("msg-1", "Added the page.");
    yield sdk.idle();
  });
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);

  const settingUp = await workerWhen(owner, project, id, ({ setup }) => setup.length === 1);
  expect(settingUp.state).toBe("setting_up");
  expect(copilot.sends.some(({ sessionId }) => sessionId === id)).toBe(false);
  install();

  const finished = await workerWhen(owner, project, id, ({ state }) => state === "finished");
  expect(finished.setup).toEqual([
    { step: "clone", command: "git clone https://github.com/octo-org/shop.git shop", exitCode: 0, log: "" },
    { step: "setup", command: "bun install", exitCode: 0, log: "3 packages installed\n" },
  ]);
  // The clone lands in the engineer's workspace, and the setup runs in it.
  const [clone, install_] = setup.runs;
  expect(install_?.cwd).toBe(join(clone?.cwd ?? "", "shop"));
  expect((await tool({ tool: "worker_transcript", worker: id })).body).toEqual({
    worker: id,
    lines: ["clone: git clone https://github.com/octo-org/shop.git shop (exit 0)", "setup: bun install (exit 0)", "setup done", "worker: Added the page."],
    truncated: false,
  });
});

test("a setup command that fails blocks the engineer: its agent never starts, its computer stops, and it keeps the step's log", async () => {
  const lockfile = "error: lockfile had changes, but lockfile is frozen\n";
  const setup = fakeSetup((command) => (command === "bun install --frozen-lockfile" ? { exitCode: 1, output: lockfile } : { exitCode: 0, output: "" }));
  const control = await teamProject({ setupShell: setup.run }, "commands:\n  setup: bun install --frozen-lockfile\n");
  const { owner, project, copilot, computers } = control;
  const { tool } = await heldTurn(control, async function* () {
    yield sdk.message("msg-1", "Never said.");
    yield sdk.idle();
  });
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);

  const blocked = await workerWhen(owner, project, id, ({ state }) => state === "blocked");

  expect(blocked).toMatchObject({ result: "Its setup failed: `bun install --frozen-lockfile` exited with 1.", computerRemoved: false });
  expect(blocked.setup.at(-1)).toEqual({ step: "setup", command: "bun install --frozen-lockfile", exitCode: 1, log: lockfile });
  expect(copilot.sends.some(({ sessionId }) => sessionId === id)).toBe(false);
  await eventually(async () => (await computers.provider.status(id)) === "stopped");
  expect(WorkerTranscript.parse((await tool({ tool: "worker_transcript", worker: id })).body).lines.slice(1)).toEqual([
    `setup: bun install --frozen-lockfile (exit 1)\n${lockfile}`,
    "error: Its setup failed: `bun install --frozen-lockfile` exited with 1.",
  ]);
});

test("an engineer's setup clones the repo through control's git proxy, and its agent works in that clone with the repo's instructions and skills", async () => {
  const socket = `/tmp/chiefbot-t61-${crypto.randomUUID().slice(0, 8)}.sock`;
  const home = mkdtempSync(join(tmpdir(), "chiefbot-home-"));
  atCleanUp(() => rmSync(home, { recursive: true, force: true }));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", CHIEFBOT_GIT_SOCKET: socket };
  const control = await teamProject(
    { setupShell: setupShell(env), gitSocket: socket },
    "commands:\n  setup: grep -c Teh README.md\ninstructions: [docs/agents.md]\nskills: [.agents/skills, tools/skills]\n",
    { "AGENTS.md": "Run bun test before you push.\n", "docs/agents.md": "Prices are in cents.\n", ".agents/skills/release/SKILL.md": "---\nname: release\n---\n" },
  );
  // What the worker gives its shells (index.ts): github.com goes to control's proxy, which reads the fake GitHub.
  const helper = join(import.meta.dir, "../../worker/src/gitCredential.ts");
  Object.assign(env, gitProxyConfig({ controlUrl: control.url, helper: `"${process.execPath}" ${helper}` }));
  const { owner, project, copilot } = control;
  const { tool } = await heldTurn(control, async function* () {
    yield sdk.message("msg-1", "Read the code.");
    yield sdk.idle();
  });
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);

  const finished = await workerWhen(owner, project, id, ({ state }) => state === "finished");

  expect(finished.setup.map(({ step, exitCode, log }) => [step, exitCode, log.trim()])).toEqual([
    ["clone", 0, "Cloning into 'shop'..."],
    ["setup", 0, "1"],
  ]);
  const at = copilot.sessionIds.indexOf(id);
  const clone = copilot.workingDirectories[at] ?? "";
  expect(clone.endsWith(`/${id}/shop`)).toBe(true);
  expect(await Bun.file(join(clone, "README.md")).text()).toBe("# Shop\nTeh shop.\n");
  const told = copilot.instructions[at] ?? "";
  expect(told).toContain('<file path="AGENTS.md">\nRun bun test before you push.\n\n</file>');
  expect(told).toContain('<file path="docs/agents.md">\nPrices are in cents.\n\n</file>');
  // A skill folder the repo lacks is left out.
  expect(copilot.skillDirectories[at]).toEqual([join(clone, ".agents/skills")]);
  expect(WorkerTranscript.parse((await tool({ tool: "worker_transcript", worker: id })).body).lines[2]).toBe(
    "setup done; instructions AGENTS.md, docs/agents.md; skills .agents/skills",
  );
});

test("an engineer gets the project's secrets for its task only: in its setup and its agent's runtime, never on the project's computer, and gone once its turn ends", async () => {
  const setup = fakeSetup((command) => ({ exitCode: 0, output: command === "bun install" ? "using API_KEY=dev-key-1\n" : "" }));
  const control = await teamProject({ setupShell: setup.run }, "commands:\n  setup: bun install\nsecrets: [API_KEY, UNSET_KEY]\n");
  const { owner, guest, project, copilot, computers } = control;
  expect((await owner.api("PUT", `/projects/${project.id}/secrets/API_KEY`, { value: "dev-key-1" })).status).toBe(204);
  let dispatched: unknown = null;
  copilot.script = async function* (prompt, runtime) {
    if (isWorker(prompt)) {
      yield sdk.message("msg-1", "Called the API.");
      yield sdk.idle();
      return;
    }
    await runtime.tool("create_task", { title: "Call the API" });
    dispatched = await answer(runtime.tool("dispatch_worker", { task: 1 }));
    yield sdk.idle();
  };

  await ask(guest, project, "Call the API");
  const { id } = TaskWorker.parse(dispatched);
  const finished = await workerWhen(owner, project, id, ({ state }) => state === "finished");

  // The setup command and the engineer's runtime get the value that is set; the clone gets none.
  expect(setup.runs.map(({ command, env }) => [command.split(" ")[0], env])).toEqual([
    ["git", {}],
    ["bun", { API_KEY: "dev-key-1" }],
  ]);
  const sessions = copilot.sessionIds.map((sessionId, at) => ({ sessionId, env: copilot.envs[at], instructions: copilot.instructions[at] ?? "" }));
  expect(sessions.filter(({ sessionId }) => sessionId === id).map(({ env }) => env)).toEqual([{ API_KEY: "dev-key-1" }]);
  // The engineer is told the name, never the value, and its setup's log hides it.
  const told = sessions.find(({ sessionId }) => sessionId === id)?.instructions ?? "";
  expect([told.includes("API_KEY"), told.includes("dev-key-1")]).toEqual([true, false]);
  expect(finished.setup[1]?.log).toBe("using API_KEY=***\n");
  // The project's computer and its coordinator's sessions never get it.
  const coordinator = sessions.filter(({ sessionId }) => sessionId !== id);
  expect(coordinator.length).toBeGreaterThan(0);
  expect(coordinator.every(({ env }) => env === undefined)).toBe(true);
  const elsewhere = JSON.stringify([computers.computers.get(project.id)?.spec, computers.computers.get(id)?.spec, coordinator, copilot.sends, await workersOf(owner, project)]);
  expect(elsewhere).not.toContain("dev-key-1");
  // Its turn is over: its session closed, and the runtime that held the secret with it.
  await eventually(() => copilot.closed.includes(id));
});

test("an engineer's messages, errors and result hide the project's secrets, one split across deltas too, and a pull request that holds one is refused before anyone is asked", async () => {
  const secret = "sk-live-4f9a2b7c1d8e";
  const control = await teamProject({}, "commands:\n  test: bun test\nsecrets: [API_KEY]\n");
  const { owner, project, github } = control;
  await owner.api("PUT", `/projects/${project.id}/secrets/API_KEY`, { value: secret });
  const refusals: string[] = [];
  const { tool } = await heldTurn(control, async function* (_prompt, runtime) {
    yield sdk.delta("msg-1", `The key is ${secret.slice(0, 7)}`);
    yield sdk.delta("msg-1", `${secret.slice(7)}.`);
    const pr = { repository: "octo-org/shop", head: "fix-typo", base: "main", title: "Fix the typo" };
    for (const args of [{ ...pr, body: `Tested with ${btoa(secret)}` }, { ...pr, base: secret }]) {
      refusals.push(await runtime.tool("create_pull_request", args).then(() => "opened", (error: Error) => error.message));
    }
    yield sdk.error(`curl failed: 401 for ${encodeURIComponent(secret)}`);
  });
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);

  const failed = await workerWhen(owner, project, id, ({ state }) => state === "failed");

  expect(failed.result).toBe("curl failed: 401 for ***");
  expect(refusals).toEqual(Array(2).fill("The pull request holds one of the project's secrets in its repository, branches, title or body. Take it out, then open it again."));
  expect(github.pullRequests).toEqual([]);
  const { lines } = WorkerTranscript.parse((await tool({ tool: "worker_transcript", worker: id })).body);
  expect(lines.slice(2)).toEqual(["worker: The key is ***.", "error: curl failed: 401 for ***"]);
  expect(JSON.stringify([lines, await workersOf(owner, project)])).not.toContain(secret.slice(0, 12));
});

test("an engineer with secrets keeps its messages in order: each before the tool rows after it, and its last one is the result", async () => {
  const control = await teamProject({}, "commands:\n  test: bun test\nsecrets: [API_KEY]\n");
  const { owner, project } = control;
  await owner.api("PUT", `/projects/${project.id}/secrets/API_KEY`, { value: "sk-live-4f9a2b7c1d8e" });
  const report = "Nothing to change: the typo was fixed on main in #37.";
  const { tool } = await heldTurn(control, async function* () {
    for (const [messageId, text] of [["msg-1", "Checking."], ["msg-2", "Looking closer."], ["msg-3", report]] as const) {
      yield sdk.delta(messageId, text);
      // The SDK's whole message; only the first asks for a tool.
      yield sdk.message(messageId, text);
      if (messageId === "msg-1") yield* [sdk.toolStart("t-1", "bash", "Run bun test"), sdk.toolComplete("t-1", true)];
    }
    yield sdk.idle();
  });
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);

  expect(await workerWhen(owner, project, id, ({ state }) => state === "finished")).toMatchObject({ result: report });
  const { lines } = WorkerTranscript.parse((await tool({ tool: "worker_transcript", worker: id })).body);
  expect(lines.slice(2)).toEqual(["worker: Checking.", "tool Run bun test: succeeded", "worker: Looking closer.", `worker: ${report}`]);
});

test("an engineer whose turn ends while control reads its secrets never gets them or its task, on any connection", async () => {
  // Control's secret store, whose reads wait while `hold` is set.
  const values = new Map<string, string>();
  let hold = false;
  let reads = 0;
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const secrets = {
    get: async (name: string) => {
      if (hold) {
        reads += 1;
        await released;
      }
      return values.get(name) ?? null;
    },
    put: async (name: string, value: string) => void values.set(name, value),
    delete: async (name: string) => void values.delete(name),
  };
  const tokens = new Map<string, string>();
  const setup = fakeSetup();
  const control = await teamProject(
    {
      secrets,
      setupShell: setup.run,
      provider: (fake) => ({
        ...fake,
        async create(spec) {
          tokens.set(spec.id, spec.env.CHIEFBOT_TASK_WORKER_TOKEN ?? "");
          await fake.create(spec);
        },
      }),
    },
    "commands:\n  setup: bun install\nsecrets: [API_KEY]\n",
  );
  const { owner, project, url } = control;
  await owner.api("PUT", `/projects/${project.id}/secrets/API_KEY`, { value: "dev-key-1" });
  hold = true;
  const { tool } = await heldTurn(control);
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await eventually(() => reads > 0);

  // The worker reconnects, saying it runs no turn: control ends it. Its new connection stays open.
  const { received } = await connectAsWorker(url, id, tokens.get(id) ?? "", []);
  await workerWhen(owner, project, id, ({ state }) => state === "failed");
  release();
  await Bun.sleep(100);

  expect(received.join("\n")).not.toContain("run-task");
  expect(setup.runs).toEqual([]);
});

test("an engineer whose computer runs an image without setup is blocked at once, told to rebuild the image, and gets no task", async () => {
  const tokens = new Map<string, string>();
  const control = await teamProject({
    provider: (fake) => ({
      ...fake,
      async create(spec) {
        tokens.set(spec.id, spec.env.CHIEFBOT_TASK_WORKER_TOKEN ?? "");
        await fake.create(spec);
      },
      // An engineer's computer starts no worker of ours: the test speaks for an older one.
      async start(id) {
        if (!id.startsWith("worker_")) await fake.start(id);
      },
    }),
  });
  const { owner, project, url } = control;
  const { tool } = await heldTurn(control);
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);

  const { received } = await connectAsWorker(url, id, tokens.get(id) ?? "", [ACCESS_MODES, ATTACHMENTS]);

  const blocked = await workerWhen(owner, project, id, ({ state }) => state === "blocked");
  expect(blocked.result).toBe("Its computer runs an older Chiefbot image, which cannot set up an engineer. Rebuild the computer image (`bun run computer:build`), then dispatch the task again.");
  expect(received.join("\n")).not.toContain("run-task");
});

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

test("a dispatch beyond the project's workers.max is queued, with no computer, and launches when a running engineer ends", async () => {
  let finishFirst = () => {};
  const firstFinishes = new Promise<void>((resolve) => (finishFirst = resolve));
  const control = await teamProject({}, "commands:\n  test: bun test\nworkers:\n  max: 1\n");
  const { owner, project, computers } = control;
  const { tool } = await heldTurn(control, async function* (prompt) {
    if (prompt.includes("Task #1:")) await firstFinishes;
    yield sdk.message("msg-1", "Done.");
    yield sdk.idle();
  });
  await tool({ tool: "create_task", title: "Add dark mode" });
  const first = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, first.id, ({ state }) => state === "working");

  const second = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 2, creationId: "c-2" })).body);

  expect(second.state).toBe("queued");
  expect(computers.computers.has(second.id)).toBe(false);
  expect(TaskWorker.parse((await tool({ tool: "worker_status", worker: second.id })).body).state).toBe("queued");
  finishFirst();
  expect(await workerWhen(owner, project, second.id, ({ state }) => state === "finished")).toMatchObject({ result: "Done." });
  expect(computers.computers.has(second.id)).toBe(true);
});

test("an ended engineer keeps its place until its computer has stopped: a stop that fails is retried, and only then does a queued one launch", async () => {
  const { clock, advance } = fakeClock(Date.now());
  let stopFails = true;
  const control = await teamProject(
    {
      clock,
      provider: (fake) => ({
        ...fake,
        async stop(id) {
          if (stopFails && id.startsWith("worker_")) throw new Error("Docker is not answering");
          await fake.stop(id);
        },
      }),
    },
    "commands:\n  test: bun test\nworkers:\n  max: 1\n",
  );
  const { owner, project, computers } = control;
  const { tool } = await heldTurn(control, async function* () {
    yield sdk.message("msg-1", "Done.");
    yield sdk.idle();
  });
  await tool({ tool: "create_task", title: "Add dark mode" });
  const first = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, first.id, ({ state }) => state === "finished");

  const second = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 2, creationId: "c-2" })).body);

  expect(second.state).toBe("queued");
  expect(await computers.provider.status(first.id)).toBe("running");
  stopFails = false;
  advance(30_000);
  await workerWhen(owner, project, second.id, ({ state }) => state === "finished");
  expect(await computers.provider.status(first.id)).toBe("stopped");
});

test("a stopped engineer keeps its place until its computer is gone: a removal that fails is retried, and only then does a queued one launch", async () => {
  const { clock, advance } = fakeClock(Date.now());
  let removals = 0;
  const control = await teamProject(
    {
      clock,
      provider: (fake) => ({
        ...fake,
        async destroy(id, options) {
          if (id.startsWith("worker_") && ++removals === 1) throw new Error("Docker is not answering");
          await fake.destroy(id, options);
        },
      }),
    },
    "commands:\n  test: bun test\nworkers:\n  max: 1\n",
  );
  const { owner, project } = control;
  const { tool } = await heldTurn(control);
  await tool({ tool: "create_task", title: "Add dark mode" });
  const first = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, first.id, ({ state }) => state === "working");
  await tool({ tool: "stop_worker", worker: first.id });
  await eventually(async () => removals === 1);

  const second = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 2, creationId: "c-2" })).body);

  expect(second.state).toBe("queued");
  advance(30_000);
  await workerWhen(owner, project, second.id, ({ state }) => state === "working");
  expect(removals).toBe(2);
  expect((await workersOf(owner, project)).find(({ id }) => id === first.id)?.computerRemoved).toBe(true);
});

test("a worker's computer gets one provider call at a time: a task closed while its computer stops has it removed once the stop is over", async () => {
  const calls: string[] = [];
  const stopping = Promise.withResolvers<void>();
  const control = await teamProject({
    provider: (fake) => ({
      ...fake,
      async stop(id) {
        if (!id.startsWith("worker_")) return fake.stop(id);
        calls.push("stop");
        await stopping.promise;
        await fake.stop(id);
        calls.push("stopped");
      },
      async destroy(id, options) {
        if (id.startsWith("worker_")) calls.push("destroy");
        await fake.destroy(id, options);
      },
    }),
  });
  const { owner, project } = control;
  const { tool } = await heldTurn(control, async function* () {
    yield sdk.message("msg-1", "Done.");
    yield sdk.idle();
  });
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, id, ({ state }) => state === "finished");
  await eventually(async () => calls.length === 1);

  await tool({ tool: "update_task", number: 1, status: "done" });
  await Bun.sleep(20);
  stopping.resolve();

  await workerWhen(owner, project, id, ({ computerRemoved }) => computerRemoved);
  expect(calls).toEqual(["stop", "stopped", "destroy"]);
});

test("control that stopped tries nothing more: a computer stop that fails after it stopped is not tried again", async () => {
  const { clock, advance } = fakeClock(Date.now());
  let stops = 0;
  const answer = Promise.withResolvers<void>();
  const control = await teamProject({
    clock,
    persistent: true,
    provider: (fake) => ({
      ...fake,
      async stop(id) {
        if (!id.startsWith("worker_")) return fake.stop(id);
        stops++;
        await answer.promise;
        throw new Error("Docker is not answering");
      },
    }),
  });
  const { owner, project } = control;
  const { tool, release } = await heldTurn(control, async function* () {
    yield sdk.message("msg-1", "Done.");
    yield sdk.idle();
  });
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, id, ({ state }) => state === "finished");
  await eventually(async () => stops === 1);
  release();

  control.restart();
  // The new control's recovery tries it too; then both tries fail.
  await eventually(async () => stops === 2);
  answer.resolve();
  await Bun.sleep(20);
  advance(30_000);

  // Only the new control tries again.
  await eventually(async () => stops === 3);
  await Bun.sleep(50);
  expect(stops).toBe(3);
});

test("the worker pushes and opens its draft pull request through control, each approved by the member who asked, and the task links it", async () => {
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
  expect(github.pullRequests).toMatchObject([{ repository: "octo-org/shop", head: "fix-typo", base: "main", by: "app", draft: true }]);
  const [task] = Task.array().parse(await (await owner.api("GET", `/projects/${project.id}/tasks`)).json());
  expect(task?.links).toEqual([{ kind: "pull-request", url }]);
});

test("an engineer is told to reproduce on the base branch first, and when nothing needs to change it ends with a report and no pull request", async () => {
  const control = await teamProject();
  const { owner, project, copilot, github } = control;
  const report = "Report: README.md on main already says \"The shop\", so the typo is fixed. Nothing to change.";
  const { tool } = await heldTurn(control, async function* () {
    yield sdk.message("msg-1", report);
    yield sdk.idle();
  });
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);

  expect(await workerWhen(owner, project, id, ({ state }) => state === "finished")).toMatchObject({ result: report, pullRequest: null });
  expect(github.pushes).toEqual([]);
  const brief = copilot.sends.find(({ sessionId }) => sessionId === id)?.prompt ?? "";
  expect(brief).toContain("First reproduce the problem, or see how the code behaves now, on the base branch");
  expect(brief).toContain("If nothing needs to change (it is already fixed, or the task only asks a question), push nothing: end with a report");
  expect(brief).toContain("open a draft pull request with create_pull_request");
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

  const setUp = ["clone: git clone https://github.com/octo-org/shop.git shop (exit 0)", "setup done"];
  expect(await read()).toEqual({ worker: id, lines: [...setUp, "tool Run the tests: failed", "worker: The tests fail before my change."], truncated: false });
  expect(await read(1)).toEqual({ worker: id, lines: ["worker: The tests fail before my change."], truncated: true });
  expect(TaskWorker.parse((await tool({ tool: "worker_status", worker: id })).body).state).toBe("working");

  const stopped = await tool({ tool: "stop_worker", worker: id });

  expect(TaskWorker.parse(stopped.body)).toMatchObject({ state: "stopped", result: "The coordinator stopped this worker." });
  await workerWhen(owner, project, id, ({ computerRemoved }) => computerRemoved);
  expect(computers.destroyed).toEqual([{ id, deleteData: true }]);
  expect((await read()) as unknown).toMatchObject({ lines: [...setUp, "tool Run the tests: failed", "worker: The tests fail before my change.", "error: The coordinator stopped this worker."] });
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

  // The worker's session reaches the connector through its computer's forwarder, which adds its turn's key.
  expect(copilot.mcpServers.at(-1)?.tracker).toMatchObject({ type: "http", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/tracker$/) });
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

test("a removed member loses everything at once: their project chat closes, their queued turns go, their workers stop and their credentials stop working", async () => {
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
  const workerAuth = { authorization: `Bearer ${computers.computers.get(id)?.spec.env.CHIEFBOT_TASK_WORKER_TOKEN}` };
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
  // Its turn's key ended with its turn (turnKeys.test.ts); its own credential no longer opens its connection.
  expect((await fetch(`${url}/task-worker/${id}`, { headers: workerAuth })).status).toBe(401);
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
  const { owner, workspace, project, copilot } = control;
  const connectors = `/workspaces/${workspace.id}/connectors`;
  await owner.api("POST", connectors, { name: "tracker", title: "Tracker", server: { kind: "remote", url: upstream.url }, auth: "personal-oauth", scope: "" });
  await owner.api("PUT", `${connectors}/tracker/token`, { token: "tracker-owner" });
  const { tool } = await heldTurn(control);
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, id, ({ state }) => state === "working");
  // The worker's runtime calls a tool that may write, then goes away before the answer.
  const hangUp = new AbortController();
  const connector = connectorOf(copilot, "tracker");
  const call = fetch(connector.url, {
    method: "POST",
    headers: { ...connector.headers, "content-type": "application/json" },
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

// A project for octo-org/shop whose computers use real git: unlike
// gitTeamProject's, each worker's setup runs too (clone, a verifier's checkout),
// and it and the agent's shell reach the fake GitHub as github.com through
// control's git proxy, with the turn's key from the worker's credential helper,
// as in a real computer.
async function gitProject(projectFile?: string) {
  const home = mkdtempSync(join(tmpdir(), "chiefbot-home-"));
  atCleanUp(() => rmSync(home, { recursive: true, force: true }));
  // Short: a unix socket path must fit in about 100 bytes.
  const socket = `/tmp/chiefbot-t64-${crypto.randomUUID().slice(0, 8)}.sock`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Chiefbot",
    GIT_AUTHOR_EMAIL: "chiefbot@example.com",
    GIT_COMMITTER_NAME: "Chiefbot",
    GIT_COMMITTER_EMAIL: "chiefbot@example.com",
    CHIEFBOT_GIT_SOCKET: socket,
  };
  const control = await teamProject({ copilot: fakeCopilot({ shell: { cwd: home, env } }), setupShell: setupShell(env), gitSocket: socket }, projectFile);
  const helper = join(import.meta.dir, "../../worker/src/gitCredential.ts");
  Object.assign(env, gitProxyConfig({ controlUrl: control.url, helper: `"${process.execPath}" ${helper}` }));
  return control;
}

// A pull request someone opened on the repo from the branch fix-typo, linked on
// task #1 through the coordinator's `tool`: its URL and head commit.
async function pullRequestOnTask(control: Awaited<ReturnType<typeof teamProject>>, tool: (call: Record<string, unknown>) => Promise<unknown>) {
  const head = control.github.commit("octo-org/shop", { "README.md": "# Shop\nThe shop.\n" }, "fix-typo");
  const url = control.github.openPullRequest("octo-org/shop", { head: "fix-typo", title: "Fix a typo", body: "Teh becomes The in the README." });
  await tool({ tool: "update_task", number: 1, links: [{ kind: "pull-request", url }] });
  return { url, head };
}

const isVerifier = (prompt: string) => prompt.startsWith("You are the verifier");

test("a verifier checks the task's pull request at the head control pinned, on a fresh computer that is never the engineer's, and control refuses its pushes", async () => {
  const control = await gitProject("commands:\n  dev: bun run dev\n  devUrl: http://localhost:3000\n");
  const { owner, project, copilot, github, computers } = control;
  let push = { exitCode: 0, output: "" };
  let checkedOut = "";
  const { tool } = await heldTurn(control, async function* (prompt, runtime) {
    if (isVerifier(prompt)) {
      const clone = copilot.workingDirectories.at(-1) ?? "";
      checkedOut = (await runtime.shell(`cd ${clone} && git rev-parse HEAD`)).output.trim();
      push = await runtime.shell(`cd ${clone} && git checkout -q -b more && git commit -q --allow-empty -m more && git push -q origin more`);
    }
    yield sdk.message("msg-1", "Checked.");
    yield sdk.idle();
  });
  expect(await tool({ tool: "dispatch_verifier", task: 1, creationId: "v-0" })).toEqual({
    status: 400,
    body: { error: "invalid_tool_call", message: "Task #1 links no pull request: an engineer opens one first, and a verifier checks it." },
  });
  const engineer = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, engineer.id, ({ state }) => state === "finished");
  const { url, head } = await pullRequestOnTask(control, tool);

  const verifier = TaskWorker.parse((await tool({ tool: "dispatch_verifier", task: 1, creationId: "v-1" })).body);

  expect(verifier).toMatchObject({ kind: "verifier", taskNumber: 1, sha: head, pullRequest: url, requestedBy: "octo-user" });
  expect(engineer.kind).toBe("engineer");
  // A computer of its own: the engineer's stays stopped, keeping its disk.
  expect(computers.computers.get(verifier.id)?.spec.env.CHIEFBOT_TASK_WORKER_ID).toBe(verifier.id);
  expect(await computers.provider.status(engineer.id)).toBe("stopped");
  const finished = await workerWhen(owner, project, verifier.id, ({ state }) => state === "finished");
  expect(finished.setup.map(({ step, command, exitCode }) => [step, command, exitCode])).toEqual([
    ["clone", "git clone https://github.com/octo-org/shop.git shop", 0],
    ["checkout", `git fetch -q origin ${head} && git checkout -q --detach ${head}`, 0],
  ]);
  expect(checkedOut).toBe(head);
  const brief = copilot.sends.find(({ sessionId }) => sessionId === verifier.id)?.prompt ?? "";
  expect(brief).toContain(`Pull request: ${url}\nCommit: ${head}\nFix a typo\nTeh becomes The in the README.`);
  expect(brief).toContain("1. Start the app: run `bun run dev` in the background in the clone, and wait until http://localhost:3000 answers.");
  expect(brief).toContain("report_verdict");
  expect(brief).toContain("Keep secrets out of your screenshots: no environment pages, and no developer tools that show tokens.");
  expect(push.exitCode).not.toBe(0);
  expect(push.output).toContain("A verifier may only fetch octo-org/shop.");
  expect(github.pushes).toEqual([]);
});

// A PNG's signature and a few bytes: a screenshot, as far as a verifier's tool can tell.
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test("a verifier ends with its verdict on the task, its report and screenshots kept in the project's context once its computer is gone", async () => {
  const secret = "sk-dev-9f8e7d6c5b";
  const control = await gitProject("commands:\n  dev: bun run dev\n  devUrl: http://localhost:3000\nsecrets: [API_KEY]\n");
  const { owner, project, copilot, computers } = control;
  await owner.api("PUT", `/projects/${project.id}/secrets/API_KEY`, { value: secret });
  const said: unknown[] = [];
  const { tool } = await heldTurn(control, async function* (prompt, runtime) {
    if (isVerifier(prompt)) {
      const report = (args: Record<string, string | string[]>) =>
        runtime.tool("report_verdict", { result: "pass", summary: "The README reads The shop.", report: "", ...args }).then(
          ({ result }) => result,
          (error: Error) => error.message,
        );
      writeFileSync(join(copilot.workingDirectories.at(-1) ?? "", "home.png"), png);
      said.push(await report({ screenshots: ["README.md"] }));
      said.push(await report({ report: `Opened the README. The key ${secret} was not needed.`, screenshots: ["home.png"] }));
      said.push(await report({ result: "issues" }));
    }
    yield sdk.message("msg-1", "Checked.");
    yield sdk.idle();
  });
  const engineer = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  await workerWhen(owner, project, engineer.id, ({ state }) => state === "finished");
  const { url, head } = await pullRequestOnTask(control, tool);

  const verifier = TaskWorker.parse((await tool({ tool: "dispatch_verifier", task: 1, creationId: "v-1" })).body);

  expect(await workerWhen(owner, project, verifier.id, ({ state }) => state === "finished")).toMatchObject({ verdict: "pass" });
  const [task] = Task.array().parse((await tool({ tool: "list_tasks" })).body);
  expect(task?.verification).toMatchObject({ result: "pass", sha: head, stale: false, summary: "The README reads The shop.", pullRequest: url, branch: "fix-typo", worker: verifier.id });
  const evidence = task?.verification?.evidence ?? "";
  expect(evidence).toStartWith(`verify/task-1-${head.slice(0, 7)}-`);
  expect(said).toEqual([
    "README.md is not a PNG image: report_verdict takes PNG screenshots only.",
    `Recorded your verdict, pass. Your report is in the project's context at ${evidence}.`,
    "A verifier reports one verdict, and yours is recorded.",
  ]);

  // The task is done: the verifier's computer goes, its evidence stays.
  await tool({ tool: "update_task", number: 1, status: "done" });
  await eventually(() => computers.destroyed.some(({ id }) => id === verifier.id));
  const file = ContextFileText.parse(await (await owner.api("GET", `/projects/${project.id}/context/file?path=${evidence}`)).json());
  expect(file.content).toContain(`${url} at ${head}`);
  expect(file.content).toContain("The README reads The shop.");
  expect(file.content).toContain("Opened the README. The key *** was not needed.");
  const screenshot = /!\[Screenshot 1\]\(([^)]+\.png)\)/.exec(file.content)?.[1] ?? "";
  const image = await owner.api("GET", `/projects/${project.id}/context/image?path=verify/${screenshot}`);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
});

test("a verifier that gives no verdict is BLOCKED on the task: its setup failed, with its log as the report, or it ended without one", async () => {
  let installs = 0;
  const setup = fakeSetup((command) => (command === "bun install" && ++installs === 1 ? { exitCode: 1, output: "error: lockfile is frozen\n" } : { exitCode: 0, output: "" }));
  const control = await teamProject({ setupShell: setup.run }, "commands:\n  setup: bun install\n");
  const { owner, project } = control;
  const { tool } = await heldTurn(control, async function* () {
    yield sdk.message("msg-1", "I looked around.");
    yield sdk.idle();
  });
  const { head } = await pullRequestOnTask(control, tool);
  const verificationOf = async () => Task.array().parse((await tool({ tool: "list_tasks" })).body)[0]?.verification;

  const first = TaskWorker.parse((await tool({ tool: "dispatch_verifier", task: 1, creationId: "v-1" })).body);

  expect(await workerWhen(owner, project, first.id, ({ verdict }) => verdict !== null)).toMatchObject({ state: "blocked", verdict: "blocked" });
  const blocked = await verificationOf();
  expect(blocked).toMatchObject({ result: "blocked", sha: head, worker: first.id, summary: "Its setup failed: `bun install` exited with 1." });
  const file = ContextFileText.parse(await (await owner.api("GET", `/projects/${project.id}/context/file?path=${blocked?.evidence}`)).json());
  expect(file.content).toContain("`bun install` exited with 1:\n\n```\nerror: lockfile is frozen\n\n```");

  const second = TaskWorker.parse((await tool({ tool: "dispatch_verifier", task: 1, creationId: "v-2" })).body);

  expect(await workerWhen(owner, project, second.id, ({ verdict }) => verdict !== null)).toMatchObject({ state: "finished", verdict: "blocked" });
  expect(await verificationOf()).toMatchObject({ result: "blocked", worker: second.id, summary: "It ended without a verdict. Its last message: I looked around." });
});

test("a verifier whose computer runs an image that cannot verify is blocked at once, told to rebuild the image, and BLOCKED on the task", async () => {
  const tokens = new Map<string, string>();
  const control = await teamProject({
    provider: (fake) => ({
      ...fake,
      async create(spec) {
        tokens.set(spec.id, spec.env.CHIEFBOT_TASK_WORKER_TOKEN ?? "");
        await fake.create(spec);
      },
      // The verifier's computer starts no worker of ours: the test speaks for an older one, which can set up an engineer.
      async start(id) {
        if (!id.startsWith("worker_")) await fake.start(id);
      },
    }),
  });
  const { owner, project, url } = control;
  const { tool } = await heldTurn(control);
  await pullRequestOnTask(control, tool);
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_verifier", task: 1, creationId: "v-1" })).body);

  const { received } = await connectAsWorker(url, id, tokens.get(id) ?? "", [ACCESS_MODES, ATTACHMENTS, ENGINEER_SETUP]);

  const blocked = await workerWhen(owner, project, id, ({ verdict }) => verdict !== null);
  const rebuild = "Its computer runs an older Chiefbot image, which cannot run a verifier. Rebuild the computer image (`bun run computer:build`), then dispatch the verifier again.";
  expect(blocked).toMatchObject({ state: "blocked", result: rebuild, verdict: "blocked" });
  expect(received.join("\n")).not.toContain("run-task");
  expect(Task.array().parse((await tool({ tool: "list_tasks" })).body)[0]?.verification).toMatchObject({ result: "blocked", summary: rebuild });
});

test("a push through Chiefbot that moves the pull request's branch makes its verdict stale, and one to another branch does not", async () => {
  const control = await gitProject();
  const { owner, project, copilot } = control;
  const pushes: number[] = [];
  const { tool } = await heldTurn(control, async function* (prompt, runtime) {
    if (isVerifier(prompt)) await runtime.tool("report_verdict", { result: "pass", summary: "The README reads The shop." });
    else if (isWorker(prompt)) {
      const clone = copilot.workingDirectories.at(-1) ?? "";
      pushes.push((await runtime.shell(`cd ${clone} && git checkout -q -b other && git commit -q --allow-empty -m other && git push -q origin other`)).exitCode);
      pushes.push((await runtime.shell(`cd ${clone} && git checkout -q fix-typo && git commit -q --allow-empty -m more && git push -q origin fix-typo`)).exitCode);
    }
    yield sdk.message("msg-1", "Done.");
    yield sdk.idle();
  });
  await pullRequestOnTask(control, tool);
  const verificationOf = async () => Task.array().parse((await tool({ tool: "list_tasks" })).body)[0]?.verification;
  const verifier = TaskWorker.parse((await tool({ tool: "dispatch_verifier", task: 1, creationId: "v-1" })).body);
  await workerWhen(owner, project, verifier.id, ({ state }) => state === "finished");
  expect(await verificationOf()).toMatchObject({ result: "pass", stale: false });
  const engineer = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 1, creationId: "c-1" })).body);
  const approve = async (branch: string) => {
    const detail = `git push to octo-org/shop: ${branch}`;
    const [push] = (await workerWhen(owner, project, engineer.id, ({ pendingApprovals }) => pendingApprovals[0]?.detail === detail)).pendingApprovals;
    await owner.api("POST", `/projects/${project.id}/workers/${engineer.id}/approvals/${push?.approvalId}`, { approved: true });
  };

  await approve("other");
  await eventually(() => pushes.length === 1);
  expect(await verificationOf()).toMatchObject({ stale: false });
  await approve("fix-typo");
  await workerWhen(owner, project, engineer.id, ({ state }) => state === "finished");

  expect(pushes).toEqual([0, 0]);
  expect(await verificationOf()).toMatchObject({ result: "pass", stale: true });
});

test("the project agent marks a task done only with a PASS for its pull request's head: not with none, with ISSUES, or once the head moved, even outside Chiefbot", async () => {
  const control = await teamProject();
  const { owner, project, github } = control;
  const verdicts = [
    { result: "issues", summary: "The README still says Teh." },
    { result: "pass", summary: "The README reads The shop." },
    { result: "pass", summary: "Still reads The shop." },
  ];
  const { tool } = await heldTurn(control, async function* (prompt, runtime) {
    if (isVerifier(prompt)) await runtime.tool("report_verdict", verdicts.shift() ?? {});
    yield sdk.idle();
  });
  const verify = async (creationId: string) => {
    const { id } = TaskWorker.parse((await tool({ tool: "dispatch_verifier", task: 1, creationId })).body);
    await workerWhen(owner, project, id, ({ state }) => state === "finished");
  };
  const done = (number: number) => tool({ tool: "update_task", number, status: "done" });
  const refusal = (message: string) => ({ status: 400, body: { error: "invalid_tool_call", message: `${message} A member can still mark it done in the app.` } });
  await tool({ tool: "create_task", title: "Write the changelog" });
  expect(Task.parse((await done(2)).body).status).toBe("done");
  const { url, head } = await pullRequestOnTask(control, tool);

  expect(await done(1)).toEqual(refusal(`Task #1 needs a verifier's PASS for ${url} at its head before it is done: dispatch_verifier first.`));
  await verify("v-1");
  expect(await done(1)).toEqual(refusal(`Task #1 is not done: its verifier found issues in ${url} at ${head.slice(0, 7)}. The README still says Teh.`));
  await verify("v-2");
  const moved = github.commit("octo-org/shop", { "CHANGELOG.md": "Fixed a typo.\n" }, "fix-typo");
  expect(await done(1)).toEqual(
    refusal(`Task #1 is not done: its PASS is for ${head.slice(0, 7)}, and ${url} has moved to ${moved.slice(0, 7)} since. Dispatch a verifier again.`),
  );
  expect(Task.array().parse((await tool({ tool: "list_tasks" })).body)[0]?.verification).toMatchObject({ result: "pass", sha: head, stale: true });
  await verify("v-3");

  expect(Task.parse((await done(1)).body)).toMatchObject({ status: "done", verification: { result: "pass", sha: moved, stale: false } });
});

test("a member marks a task done in the app over the done rule, and the task records who did, when and its verdict then", async () => {
  const control = await teamProject();
  const { owner, guest, project } = control;
  const { tool } = await heldTurn(control, async function* (prompt, runtime) {
    if (isVerifier(prompt)) await runtime.tool("report_verdict", { result: "issues", summary: "The README still says Teh." });
    yield sdk.idle();
  });
  const { head } = await pullRequestOnTask(control, tool);
  const { id } = TaskWorker.parse((await tool({ tool: "dispatch_verifier", task: 1, creationId: "v-1" })).body);
  await workerWhen(owner, project, id, ({ state }) => state === "finished");
  const before = Date.now();

  const res = await guest.api("POST", `/projects/${project.id}/tasks/1/done`);

  const task = Task.parse(await res.json());
  expect(task).toMatchObject({ status: "done", overrides: [{ by: "octo-friend", verification: { result: "issues", sha: head } }] });
  expect(task.overrides[0]?.at).toBeGreaterThanOrEqual(before);
  expect(Task.array().parse((await tool({ tool: "list_tasks" })).body)[0]).toEqual(task);
  expect(Task.parse((await tool({ tool: "update_task", number: 1, status: "done" })).body).status).toBe("done");
  const again = await owner.api("POST", `/projects/${project.id}/tasks/1/done`);
  expect([again.status, ApiError.parse(await again.json()).error]).toEqual([409, "task_closed"]);
  expect((await owner.api("POST", `/projects/${project.id}/tasks/9/done`)).status).toBe(404);
});

test("the project agent cannot mark a task done while a push through Chiefbot moves its pull request: one that lands while control reads the head on GitHub, or one in flight", async () => {
  const control = await gitProject();
  const { owner, project, copilot, github } = control;
  const { tool } = await heldTurn(control, async function* (prompt, runtime) {
    if (isVerifier(prompt)) await runtime.tool("report_verdict", { result: "pass", summary: "The README reads The shop." });
    else if (isWorker(prompt)) {
      const clone = copilot.workingDirectories.at(-1) ?? "";
      await runtime.shell(`cd ${clone} && git checkout -q fix-typo && git commit -q --allow-empty -m one && git push -q origin fix-typo`);
      await runtime.shell(`cd ${clone} && git commit -q --allow-empty -m two && git push -q origin fix-typo`);
    }
    yield sdk.idle();
  });
  await pullRequestOnTask(control, tool);
  const verify = async (creationId: string) => {
    const { id } = TaskWorker.parse((await tool({ tool: "dispatch_verifier", task: 1, creationId })).body);
    await workerWhen(owner, project, id, ({ state }) => state === "finished");
  };
  await verify("v-1");
  // Another task's engineer pushes twice to the pull request's branch, each push approved by the test.
  await tool({ tool: "create_task", title: "Tidy the README" });
  const engineer = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 2, creationId: "c-1" })).body);
  const nextPush = async (after?: string) => {
    const asked = await workerWhen(owner, project, engineer.id, ({ pendingApprovals }) => (pendingApprovals[0]?.approvalId ?? after) !== after);
    return asked.pendingApprovals[0]?.approvalId ?? "";
  };
  const approve = (approvalId: string) => owner.api("POST", `/projects/${project.id}/workers/${engineer.id}/approvals/${approvalId}`, { approved: true });
  const done = () => tool({ tool: "update_task", number: 1, status: "done" });
  const moved = {
    status: 400,
    body: { error: "invalid_tool_call", message: "Task #1 is not done: its pull request moved while Chiefbot checked it. Verify it again. A member can still mark it done in the app." },
  };
  const first = await nextPush();
  const reads = github.holdPullRequests();
  const landing = done();
  await eventually(() => reads.held() === 1);
  await approve(first);
  // The engineer asks for its second push once the first has landed.
  const second = await nextPush(first);
  reads.release();

  expect(await landing).toEqual(moved);

  await verify("v-2");
  const pushes = github.holdGit();
  await approve(second);
  await eventually(() => pushes.held() === 1);

  expect(await done()).toEqual(moved);

  pushes.release();
  await workerWhen(owner, project, engineer.id, ({ state }) => state === "finished");
  expect(Task.array().parse((await tool({ tool: "list_tasks" })).body)[0]).toMatchObject({ status: "open", verification: { result: "pass", stale: true } });
});

test("a pull request linked on a done task reopens it, so done needs a PASS for it; a member can still mark it done, and a task that ended in a report stays done", async () => {
  const control = await teamProject();
  const { owner, project, github } = control;
  const { tool } = await heldTurn(control);
  const update = async (call: Record<string, unknown>) => {
    const { status, body } = await tool({ tool: "update_task", number: 1, ...call });
    return status === 200 ? Task.parse(body).status : body;
  };
  expect(await update({ status: "done", links: [{ kind: "url", url: "https://example.com/report" }] })).toBe("done");
  expect(await update({ detail: "The README says Teh." })).toBe("done");
  github.commit("octo-org/shop", { "README.md": "# Shop\nThe shop.\n" }, "fix-typo");
  const url = github.openPullRequest("octo-org/shop", { head: "fix-typo", title: "Fix a typo" });
  const link = [{ kind: "pull-request", url }];
  const refusal = {
    error: "invalid_tool_call",
    message: `Task #1 needs a verifier's PASS for ${url} at its head before it is done: dispatch_verifier first. A member can still mark it done in the app.`,
  };

  expect(await update({ status: "done", links: link })).toEqual(refusal);
  expect(await update({ links: link })).toBe("in_progress");
  expect(await update({ status: "done" })).toEqual(refusal);
  const res = await owner.api("POST", `/projects/${project.id}/tasks/1/done`);
  expect(Task.parse(await res.json())).toMatchObject({ status: "done", overrides: [{ by: "octo-user", verification: null }] });
});

test("a verifier's PASS is stale when a push through Chiefbot moved the pull request's branch after control pinned its commit", async () => {
  const control = await gitProject("commands:\n  test: bun test\nworkers:\n  max: 1\n");
  const { owner, project, copilot } = control;
  const { tool } = await heldTurn(control, async function* (prompt, runtime) {
    if (isVerifier(prompt)) await runtime.tool("report_verdict", { result: "pass", summary: "The README reads The shop." });
    else if (isWorker(prompt)) {
      const clone = copilot.workingDirectories.at(-1) ?? "";
      await runtime.shell(`cd ${clone} && git checkout -q fix-typo && git commit -q --allow-empty -m more && git push -q origin fix-typo`);
    }
    yield sdk.idle();
  });
  const { head } = await pullRequestOnTask(control, tool);
  await tool({ tool: "create_task", title: "Tidy the README" });
  const engineer = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 2, creationId: "c-1" })).body);
  const [push] = (await workerWhen(owner, project, engineer.id, ({ pendingApprovals }) => pendingApprovals.length > 0)).pendingApprovals;
  const verifier = TaskWorker.parse((await tool({ tool: "dispatch_verifier", task: 1, creationId: "v-1" })).body);
  expect(verifier).toMatchObject({ state: "queued", sha: head });

  await owner.api("POST", `/projects/${project.id}/workers/${engineer.id}/approvals/${push?.approvalId}`, { approved: true });

  expect(await workerWhen(owner, project, verifier.id, ({ verdict }) => verdict !== null)).toMatchObject({ verdict: "pass", sha: head });
  expect(Task.array().parse((await tool({ tool: "list_tasks" })).body)[0]?.verification).toMatchObject({ result: "pass", sha: head, stale: true });
});

test("a verifier that follows the repo's verify skill still gets the project's dev command and URL", async () => {
  const control = await teamProject({}, "verify: check-ui\ncommands:\n  dev: bun run dev\n  devUrl: http://localhost:3000\n");
  const { copilot } = control;
  const { tool } = await heldTurn(control);
  await pullRequestOnTask(control, tool);

  const verifier = TaskWorker.parse((await tool({ tool: "dispatch_verifier", task: 1, creationId: "v-1" })).body);

  await eventually(() => copilot.sends.some(({ sessionId }) => sessionId === verifier.id));
  const brief = copilot.sends.find(({ sessionId }) => sessionId === verifier.id)?.prompt ?? "";
  expect(brief).toContain("Check it as the repo's `check-ui` skill says: it is among your skills.");
  expect(brief).toContain("Start the app with `bun run dev` in the clone. It answers at http://localhost:3000.");
});

test("a verifier takes one of the project's workers.max places, as an engineer does: beyond it, it is queued, and checks its pinned commit once one ends", async () => {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const control = await teamProject({}, "commands:\n  test: bun test\nworkers:\n  max: 1\n");
  const { owner, project, computers } = control;
  const { tool } = await heldTurn(control, async function* (prompt, runtime) {
    if (isVerifier(prompt)) await runtime.tool("report_verdict", { result: "pass", summary: "The README reads The shop." });
    else await finished;
    yield sdk.idle();
  });
  const { head } = await pullRequestOnTask(control, tool);
  await tool({ tool: "create_task", title: "Add dark mode" });
  const engineer = TaskWorker.parse((await tool({ tool: "dispatch_worker", task: 2, creationId: "c-1" })).body);
  await workerWhen(owner, project, engineer.id, ({ state }) => state === "working");

  const verifier = TaskWorker.parse((await tool({ tool: "dispatch_verifier", task: 1, creationId: "v-1" })).body);

  expect(verifier).toMatchObject({ state: "queued", sha: head });
  expect(computers.computers.has(verifier.id)).toBe(false);
  finish();
  expect(await workerWhen(owner, project, verifier.id, ({ verdict }) => verdict !== null)).toMatchObject({ state: "finished", verdict: "pass", sha: head });
});
