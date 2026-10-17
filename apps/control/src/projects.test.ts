import { afterEach, expect, test } from "bun:test";
import { ApiError, BrokeredGitHubToken, ClientEvent, ContextFile, Project, Task, User, Workspace, WorkspaceInvite, type ChatEvent, type ProjectId } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { fakeCopilot, sdk } from "@chiefbot/worker/fake-copilot";
import { fakeClock } from "./clock.ts";
import { atCleanUp, cleanUp, doneCount, eventually, startTestControl, type TestControlOptions, type TestUser } from "./testControl.ts";

afterEach(cleanUp);

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } };

const projectFile = `# How agents build and test this repo
connectors: [github, jira]
environments:
  - name: web
commands:
  build: bun run build
  test: bun test
`;

// Control with a workspace owned by the signed-in user, octo-friend as its
// member, and a repo octo-org/shop holding `files` (by default a valid project file).
async function team(files: Record<string, string> = { "chiefbot.project.yaml": projectFile }, options: TestControlOptions = {}) {
  const control = await startTestControl(options);
  const owner = control.user;
  const workspace = Workspace.parse(await (await owner.api("POST", "/workspaces", { name: "Platform team" })).json());
  await owner.api("POST", `/workspaces/${workspace.id}/invites`, { login: friend.login });
  const guest = await control.signIn(friend);
  const [invite] = WorkspaceInvite.array().parse(await (await guest.api("GET", "/invites")).json());
  await guest.api("POST", `/invites/${invite?.id}/accept`);
  control.github.createRepo("octo-org/shop", files);
  const createProject = (repo = "octo-org/shop") => owner.api("POST", `/workspaces/${workspace.id}/projects`, { repo });
  return { ...control, owner, guest, workspace, createProject };
}

test("a member creates a project from a repo: control reads its project file, and the coordinator's computer comes up", async () => {
  const { owner, guest, workspace, createProject, computers, signIn } = await team();

  const res = await createProject();

  expect(res.status).toBe(201);
  const project = Project.parse(await res.json());
  expect(project).toMatchObject({
    workspaceId: workspace.id,
    name: "shop",
    repo: "octo-org/shop",
    file: { connectors: ["github", "jira"], environments: [{ name: "web" }], commands: { build: "bun run build", test: "bun test" } },
  });
  expect(await computers.provider.status(project.id)).toBe("running");
  // Every member sees it; anyone else gets 404.
  expect(Project.array().parse(await (await guest.api("GET", `/workspaces/${workspace.id}/projects`)).json())).toEqual([project]);
  expect(Project.parse(await (await guest.api("GET", `/projects/${project.id}`)).json())).toEqual(project);
  const stranger = await signIn({ id: 6161, login: "octo-stranger", copilot: null });
  expect((await stranger.api("GET", `/projects/${project.id}`)).status).toBe(404);
  // One project per repo in a workspace.
  expect([(await createProject()).status, (await owner.api("GET", `/workspaces/${workspace.id}/projects`)).status]).toEqual([409, 200]);
});

test("an invalid project file gives a clear error, and no project is made", async () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ "README.md": "# Shop" }, "No chiefbot.project.yaml at the root of octo-org/shop"],
    [{ "chiefbot.project.yaml": "commands: [unclosed" }, "chiefbot.project.yaml is not valid YAML"],
    [{ "chiefbot.project.yaml": "commands:\n  test: 42\n" }, "commands.test: Invalid input: expected string, received number"],
    [{ "chiefbot.project.yaml": "conectors: [github]\n" }, 'Unrecognized key: "conectors"'],
  ];
  for (const [files, message] of cases) {
    const { owner, workspace, createProject, computers } = await team(files);

    const res = await createProject();

    const body = ApiError.parse(await res.json());
    expect([res.status, body.error]).toEqual([400, "invalid_project_file"]);
    expect(body.message).toContain(message);
    expect(await (await owner.api("GET", `/workspaces/${workspace.id}/projects`)).json()).toEqual([]);
    expect(computers.computers.size).toBe(0);
    cleanUp();
  }
});

test("only the workspace owner deletes a project, and its computer goes with it", async () => {
  const { owner, guest, workspace, createProject, computers } = await team();
  const project = Project.parse(await (await createProject()).json());

  const refused = await guest.api("DELETE", `/projects/${project.id}`);
  const deleted = await owner.api("DELETE", `/projects/${project.id}`);

  expect([refused.status, ApiError.parse(await refused.json()).error]).toEqual([403, "owner_only"]);
  expect(deleted.status).toBe(204);
  expect(computers.destroyed).toEqual([{ id: project.id, deleteData: true }]);
  expect((await guest.api("GET", `/projects/${project.id}`)).status).toBe(404);
  expect(await (await owner.api("GET", `/workspaces/${workspace.id}/projects`)).json()).toEqual([]);
});

// A team with a project for octo-org/shop whose coordinator is online.
async function teamProject(options: TestControlOptions = {}) {
  const control = await team(undefined, options);
  const project = Project.parse(await (await control.createProject()).json());
  return { ...control, project };
}

// Sends a member's message to the project's coordinator; resolves once control queued it.
async function ask(member: TestUser, project: Project, text: string) {
  const res = await member.api("POST", `/projects/${project.id}/messages`, { text });
  if (res.status !== 202) throw new Error(`ask failed: ${res.status} ${await res.text()}`);
}

// The assistant's text in a chat, one string per message.
const replies = (events: ChatEvent[]) => {
  const messages = new Map<string, string>();
  for (const { turnId, event } of events) {
    if (event.type === "text-delta") messages.set(`${turnId}:${event.messageId}`, (messages.get(`${turnId}:${event.messageId}`) ?? "") + event.text);
  }
  return [...messages.values()];
};

const tasksOf = async (member: TestUser, project: Project) =>
  Task.array().parse(await (await member.api("GET", `/projects/${project.id}/tasks`)).json());

// Every task ledger control sends the member's /events socket.
function watchLedgers(url: string, member: TestUser) {
  const ledgers: Task[][] = [];
  const socket = new WebSocket(`${url.replace("http", "ws")}/events`, { headers: member.auth });
  atCleanUp(() => socket.close());
  socket.onmessage = (message) => {
    const event = ClientEvent.parse(JSON.parse(String(message.data)));
    if (event.type === "tasks") ledgers.push(event.tasks);
  };
  return { ledgers, opened: new Promise((resolve) => (socket.onopen = resolve)) };
}

// What a fake coordinator tool call answered: its JSON, or the refusal's message.
const answer = (call: Promise<{ result: unknown }>) =>
  call.then(
    ({ result }): unknown => JSON.parse(String(result)),
    (error: Error) => ({ refused: error.message }),
  );

test("each member has their own chat with the coordinator, and each turn runs on that member's Copilot seat", async () => {
  const { owner, guest, project, copilot } = await teamProject();
  const ownerChat = owner.watchProjectChat(project.id);
  const guestChat = guest.watchProjectChat(project.id);

  await ask(owner, project, "hi from the owner");
  await ask(guest, project, "hi from a member");

  expect(replies(await ownerChat.until(doneCount(1)))).toEqual(["You said: hi from the owner"]);
  expect(replies(await guestChat.until(doneCount(1)))).toEqual(["You said: hi from a member"]);
  expect(ownerChat.events.map(({ event }) => event.type === "user-message" && event.text).filter(Boolean)).toEqual(["hi from the owner"]);
  expect(copilot.tokens).toEqual([owner.tokens.accessToken, guest.tokens.accessToken]);
  expect(new Set(copilot.sessionIds).size).toBe(2);
  // A member's next message waits until their last one is answered.
  copilot.script = async function* () {
    await new Promise(() => {});
  };
  await ask(owner, project, "and another thing");
  const busy = await owner.api("POST", `/projects/${project.id}/messages`, { text: "and another" });
  expect([busy.status, ApiError.parse(await busy.json()).error]).toEqual([409, "turn_running"]);
});

test("the coordinator keeps the task ledger and shared context in control, and members see the ledger change live", async () => {
  const { url, owner, guest, project, copilot } = await teamProject();
  const live = watchLedgers(url, guest);
  await live.opened;
  const answers: unknown[] = [];
  copilot.script = async function* (_prompt, runtime) {
    answers.push(await answer(runtime.tool("create_task", { title: "Add a checkout page", detail: "From cart to payment", owner: "Octo-Friend" })));
    await runtime.tool("write_context", { path: "plans/checkout.md", content: "# Checkout\n" });
    await runtime.tool("update_task", { number: 1, status: "in_progress", links: [{ kind: "context", path: "plans/checkout.md" }] });
    answers.push(await answer(runtime.tool("read_context", {})), await answer(runtime.tool("read_context", { path: "plans/checkout.md" })));
    yield sdk.idle();
  };

  await ask(owner, project, "Plan a checkout page for octo-friend");
  await owner.watchProjectChat(project.id).until(doneCount(1));

  const [task] = await tasksOf(guest, project);
  expect(task).toMatchObject({
    number: 1,
    title: "Add a checkout page",
    detail: "From cart to payment",
    status: "in_progress",
    owner: "octo-friend",
    requestedBy: "octo-user",
    links: [{ kind: "context", path: "plans/checkout.md" }],
  });
  expect(answers[0]).toMatchObject({ number: 1, status: "open" });
  expect(ContextFile.array().parse(answers[1])).toMatchObject([{ path: "plans/checkout.md", size: 11 }]);
  expect(answers[2]).toEqual({ path: "plans/checkout.md", content: "# Checkout\n" });
  await eventually(() => live.ledgers.length === 2);
  expect(live.ledgers.map((ledger) => ledger.map(({ status }) => status))).toEqual([["open"], ["in_progress"]]);
});

test("a coordinator tool call that breaks the ledger's rules is refused with the reason", async () => {
  const { owner, project, copilot } = await teamProject();
  const answers: unknown[] = [];
  copilot.script = async function* (_prompt, runtime) {
    answers.push(
      await answer(runtime.tool("create_task", { title: "Ship it", owner: "octo-stranger" })),
      await answer(runtime.tool("update_task", { number: 7, status: "done" })),
      await answer(runtime.tool("read_context", { path: "missing.md" })),
    );
    yield sdk.idle();
  };

  await ask(owner, project, "go");
  await owner.watchProjectChat(project.id).until(doneCount(1));

  expect(answers).toEqual([
    { refused: "octo-stranger is not a member of this project's workspace" },
    { refused: "No task #7 in this project" },
    { refused: "No context file missing.md" },
  ]);
  expect(await tasksOf(owner, project)).toEqual([]);
});

test("a coordinator's credential reaches only its own project, and only the seat of the member whose turn runs", async () => {
  const { url, owner, guest, project, computers, github, createProject, copilot } = await teamProject();
  github.createRepo("octo-org/api", { "chiefbot.project.yaml": "" });
  const other = Project.parse(await (await createProject("octo-org/api")).json());
  // The credential control handed the project's computer.
  const tokenOf = (id: ProjectId) => ({ authorization: `Bearer ${computers.computers.get(id)?.spec.env.CHIEFBOT_PROJECT_TOKEN}` });
  const ownerId = User.parse(await (await owner.api("GET", "/me")).json()).id;
  const guestId = User.parse(await (await guest.api("GET", "/me")).json()).id;
  let release = () => {};
  copilot.script = async function* () {
    await new Promise<void>((resolve) => (release = resolve));
    yield sdk.idle();
  };
  const listTasks = { method: "POST", body: JSON.stringify({ tool: "list_tasks" }) };

  const idle = await fetch(`${url}/coordinator/${project.id}/tools`, { ...listTasks, headers: tokenOf(project.id) });
  await ask(owner, project, "hold on");
  await eventually(() => copilot.sends.length === 1);
  const crossed = await fetch(`${url}/coordinator/${project.id}/tools`, { ...listTasks, headers: tokenOf(other.id) });
  const ownSeat = await fetch(`${url}/coordinator/${project.id}/github-token/${ownerId}`, { headers: tokenOf(project.id) });
  const otherSeat = await fetch(`${url}/coordinator/${project.id}/github-token/${guestId}`, { headers: tokenOf(project.id) });
  release();

  expect([idle.status, ApiError.parse(await idle.json())]).toEqual([409, { error: "invalid_tool_call", message: "No coordinator turn is running" }]);
  expect(crossed.status).toBe(403);
  expect([ownSeat.status, BrokeredGitHubToken.parse(await ownSeat.json()).accessToken]).toEqual([200, owner.tokens.accessToken]);
  expect(otherSeat.status).toBe(404);
});

test("two members asking for the same thing get one task: the project's scheduler runs one coordinator turn at a time", async () => {
  const { owner, guest, project, copilot } = await teamProject();
  let release = () => {};
  const paused = new Promise<void>((resolve) => (release = resolve));
  // Like a model following its instructions: it lists the ledger and creates a
  // task only when none covers the request. The first turn holds after listing.
  copilot.script = async function* (_prompt, runtime) {
    const listed = Task.array().parse(JSON.parse(String((await runtime.tool("list_tasks", {})).result)));
    await paused;
    if (!listed.some(({ title }) => title === "Add dark mode")) await runtime.tool("create_task", { title: "Add dark mode" });
    yield sdk.idle();
  };

  await ask(owner, project, "We need dark mode");
  await ask(guest, project, "Can we get dark mode?");
  await eventually(() => copilot.sends.length === 1);
  await Bun.sleep(100);
  expect(copilot.sends.map(({ prompt }) => prompt)).toEqual(["We need dark mode"]);
  release();

  await owner.watchProjectChat(project.id).until(doneCount(1));
  await guest.watchProjectChat(project.id).until(doneCount(1));
  expect(copilot.sends.map(({ prompt }) => prompt)).toEqual(["We need dark mode", "Can we get dark mode?"]);
  expect((await tasksOf(owner, project)).map(({ title, requestedBy }) => [title, requestedBy])).toEqual([["Add dark mode", "octo-user"]]);
});

test("a coordinator that restarts mid-turn ends that turn with an error, then runs the next member's", async () => {
  const { owner, guest, project, computers, copilot } = await teamProject();
  copilot.script = async function* () {
    yield sdk.delta("msg-1", "Thinking");
    await new Promise(() => {});
  };
  const ownerChat = owner.watchProjectChat(project.id);
  await ask(owner, project, "never finishes");
  await ownerChat.until((events) => events.some(({ event }) => event.type === "text-delta"));
  await ask(guest, project, "my turn");

  copilot.script = fakeCopilot().script;
  await computers.provider.stop(project.id);
  await computers.provider.start(project.id);

  expect((await ownerChat.until(doneCount(1))).map(({ event }) => event.type)).toEqual(["user-message", "payer", "text-delta", "error", "done"]);
  expect(replies(await guest.watchProjectChat(project.id).until(doneCount(1)))).toEqual(["You said: my turn"]);
});

test("a coordinator's computer stops once idle, not while a turn runs, and the next message starts it again", async () => {
  const minute = 60_000;
  const time = fakeClock(Date.now());
  const { owner, project, computers, copilot } = await teamProject({ clock: time.clock, idleStopMinutes: 30 });
  let release = () => {};
  copilot.script = async function* () {
    await new Promise<void>((resolve) => (release = resolve));
    yield sdk.message("msg-1", "Done.");
    yield sdk.idle();
  };
  const chat = owner.watchProjectChat(project.id);
  await ask(owner, project, "a long one");
  await eventually(() => copilot.sends.length === 1);

  time.advance(3 * 60 * minute);
  await Bun.sleep(50);
  expect(await computers.provider.status(project.id)).toBe("running");
  release();
  await chat.until(doneCount(1));
  time.advance(29 * minute);
  await Bun.sleep(50);
  expect(await computers.provider.status(project.id)).toBe("running");
  time.advance(2 * minute);
  await eventually(async () => (await computers.provider.status(project.id)) === "stopped");

  copilot.script = fakeCopilot().script;
  await ask(owner, project, "wake up");

  expect(replies(await chat.until(doneCount(2)))).toEqual(["Done.", "You said: wake up"]);
  expect(await computers.provider.status(project.id)).toBe("running");
  expect(computers.destroyed).toEqual([]);
});
