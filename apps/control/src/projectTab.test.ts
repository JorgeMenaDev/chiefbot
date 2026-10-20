import { afterEach, expect, test } from "bun:test";
import { ApiError, ChatEvent, ClientEvent, ContextFile, ContextFileText, ContextPath, Project, TaskWorker, User, Workspace, WorkspaceInvite, type ProjectId, type ProjectState } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { sdk, type FakeScript } from "@chiefbot/worker/fake-copilot";
import { atCleanUp, cleanUp, eventually, fakeCoordinator, startTestControl, type TestControl, type TestUser } from "./testControl.ts";

// What the desktop's Projects tab reads from control: each project's state dot,
// a running engineer's screen and transcript, and the shared context.

afterEach(cleanUp);

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } };

type TeamProject = Awaited<ReturnType<typeof teamProject>>;

// Control with a workspace owned by the signed-in user, octo-friend as its
// member, and a project for octo-org/shop.
async function teamProject() {
  const control = await startTestControl();
  const owner = control.user;
  const workspace = Workspace.parse(await (await owner.api("POST", "/workspaces", { name: "Platform team" })).json());
  await owner.api("POST", `/workspaces/${workspace.id}/invites`, { login: friend.login });
  const guest = await control.signIn(friend);
  const [invite] = WorkspaceInvite.array().parse(await (await guest.api("GET", "/invites")).json());
  await guest.api("POST", `/invites/${invite?.id}/accept`);
  control.github.createRepo("octo-org/shop", { "README.md": "# Shop\n" }, { access: { "octo-user": "write", "octo-friend": "write" } });
  const project = Project.parse(await (await owner.api("POST", `/workspaces/${workspace.id}/projects`, { repo: "octo-org/shop" })).json());
  return { ...control, owner, guest, workspace, project };
}

// The project states a member's /events socket has said: a whole snapshot
// replaces them, a change sets one.
function watchStates({ url }: TestControl, member: TestUser) {
  const socket = new WebSocket(`${url.replace("http", "ws")}/events`, { headers: member.auth });
  atCleanUp(() => socket.close());
  let states = new Map<ProjectId, ProjectState>();
  socket.onmessage = (event) => {
    const message = ClientEvent.parse(JSON.parse(String(event.data)));
    if (message.type === "project-states") states = new Map(Object.entries(message.states) as Array<[ProjectId, ProjectState]>);
    if (message.type === "project-state") states.set(message.projectId, message.state);
  };
  return {
    until: (projectId: ProjectId, state: ProjectState) => eventually(() => states.get(projectId) === state),
    gone: (projectId: ProjectId) => eventually(() => !states.has(projectId)),
    has: (projectId: ProjectId) => states.has(projectId),
  };
}

// A fake coordinator takes the project's and holds the owner's turn open, after
// making task #1, so the test calls the coordinator's tools on control with the
// turn's key. Engineers run `engineer` on the fake Copilot: by default they never finish.
async function heldTurn(control: Awaited<ReturnType<typeof teamProject>>, engineer: FakeScript = forever) {
  const { url, project, owner, copilot } = control;
  copilot.script = engineer;
  const coordinator = await fakeCoordinator(control, project.id);
  coordinator.hello(null);
  await owner.api("POST", `/projects/${project.id}/messages`, { text: "Fix the typo" });
  const { turnId, turnKey } = await coordinator.nth("run-turn");
  const tool = (call: Record<string, unknown>) =>
    fetch(`${url}/coordinator/${project.id}/tools`, { method: "POST", headers: { authorization: `Bearer ${turnKey}` }, body: JSON.stringify(call) });
  await tool({ tool: "create_task", title: "Fix the typo" });
  return { coordinator, tool, release: () => coordinator.event(turnId, { type: "done" }) };
}

const forever: FakeScript = async function* () {
  await new Promise(() => {});
};

// An engineer on task #1 whose worker is connected and runs `script`.
async function runningEngineer(control: Awaited<ReturnType<typeof teamProject>>, script: FakeScript = forever) {
  const turn = await heldTurn(control, script);
  const engineer = TaskWorker.parse(await (await turn.tool({ tool: "dispatch_worker", task: 1, creationId: "session/call-1" })).json());
  await eventually(async () => (await engineerOf(control.owner, control.project, engineer))?.state === "working");
  return { ...turn, engineer };
}

const engineerOf = async (member: TestUser, project: Project, { id }: TaskWorker) =>
  TaskWorker.array()
    .parse(await (await member.api("GET", `/projects/${project.id}/workers`)).json())
    .find((worker) => worker.id === id);

test("each member sees a project's state: sleeping while its computer is stopped, working on a message, needs you only for whom a task asks", async () => {
  const control = await teamProject();
  const { url, owner, guest, project } = control;
  const ownerStates = watchStates(control, owner);
  const guestStates = watchStates(control, guest);
  await ownerStates.until(project.id, "idle");

  // Its computer stops; the fake coordinator connects, and is ready once it says hello.
  const coordinator = await fakeCoordinator(control, project.id);
  await ownerStates.until(project.id, "sleeping");
  coordinator.hello(null);
  await guestStates.until(project.id, "idle");

  await owner.api("POST", `/projects/${project.id}/messages`, { text: "Fix the typo" });
  const { turnId, turnKey } = await coordinator.nth("run-turn");
  await guestStates.until(project.id, "working");
  const tool = (call: Record<string, unknown>) =>
    fetch(`${url}/coordinator/${project.id}/tools`, { method: "POST", headers: { authorization: `Bearer ${turnKey}` }, body: JSON.stringify(call) });
  await tool({ tool: "create_task", title: "Fix the typo" });
  await tool({ tool: "update_task", number: 1, status: "needs_input", question: "Which page?" });
  coordinator.event(turnId, { type: "done" });

  await ownerStates.until(project.id, "needs_you");
  await guestStates.until(project.id, "idle");
});

test("a deleted project leaves every member's states at once, and a workspace's projects leave a member who is removed", async () => {
  const control = await teamProject();
  const { owner, guest, project, workspace, github } = control;
  github.createRepo("octo-org/api", { "README.md": "# API\n" }, { access: { "octo-user": "write", "octo-friend": "write" } });
  const api = Project.parse(await (await owner.api("POST", `/workspaces/${workspace.id}/projects`, { repo: "octo-org/api" })).json());
  const ownerStates = watchStates(control, owner);
  const guestStates = watchStates(control, guest);
  await ownerStates.until(project.id, "idle");
  await guestStates.until(api.id, "idle");

  expect((await owner.api("DELETE", `/projects/${project.id}`)).status).toBe(204);
  await ownerStates.gone(project.id);
  await guestStates.gone(project.id);
  expect(ownerStates.has(api.id)).toBe(true);

  const guestId = User.parse(await (await guest.api("GET", "/me")).json()).id;
  await owner.api("DELETE", `/workspaces/${workspace.id}/members/${guestId}`);
  await guestStates.gone(api.id);
  expect(ownerStates.has(api.id)).toBe(true);
});

// A viewer on an engineer's screen through control, as the desktop's noVNC opens it.
function openScreen({ url }: TestControl, project: Project, engineer: TaskWorker, headers: Record<string, string>) {
  const socket = new WebSocket(`${url.replace("http", "ws")}/projects/${project.id}/workers/${engineer.id}/screen`, { headers });
  socket.binaryType = "arraybuffer";
  atCleanUp(() => socket.close());
  const received: string[] = [];
  socket.onmessage = (event) => {
    received.push(event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : String(event.data));
  };
  return { socket, received };
}

test("a member watches a running engineer's screen through control, with bytes flowing both ways", async () => {
  const control = await teamProject();
  const { engineer } = await runningEngineer(control);

  const viewer = openScreen(control, control.project, engineer, control.guest.auth);

  // The fake screen greets like a VNC server; the viewer's reply reaches it.
  await eventually(() => viewer.received.join("") === "RFB 003.008\n");
  viewer.socket.send(new TextEncoder().encode("RFB 003.008\n"));
  await eventually(() => control.computers.screenInput.get(engineer.id)?.join("") === "RFB 003.008\n");
});

test("only the project's members reach an engineer's screen, and only while its worker runs", async () => {
  const control = await teamProject();
  const { url, project, owner, signIn } = control;
  const { engineer } = await runningEngineer(control);
  const outsider = await signIn({ id: 666, login: "mallory", copilot: null });
  const screen = `${url}/projects/${project.id}/workers/${engineer.id}/screen`;

  expect((await fetch(screen, { headers: outsider.auth })).status).toBe(404);
  expect((await outsider.api("POST", `/projects/${project.id}/workers/${engineer.id}/take-over`)).status).toBe(404);
  expect((await fetch(screen)).status).toBe(401);

  await control.computers.provider.stop(engineer.id);
  await eventually(async () => (await fetch(screen, { headers: owner.auth })).status === 409);
});

test("an engineer's worker joins only a screen stream control opened for it", async () => {
  const control = await teamProject();
  const { url, computers } = control;
  const { engineer } = await runningEngineer(control);
  const token = computers.computers.get(engineer.id)?.spec.env.CHIEFBOT_TASK_WORKER_TOKEN ?? "";
  const join = (workerId: string, streamId: string) => fetch(`${url}/task-worker/${workerId}/screen/${streamId}`, { headers: { authorization: `Bearer ${token}` } });

  expect((await join("worker_other", "any")).status).toBe(403);
  expect((await join(engineer.id, "never-opened")).status).toBe(404);
});

// A member's view of an engineer's screen, past noVNC's opening bytes (RFB 3.8,
// security None, ClientInit), so what it sends next are RFB messages.
async function viewer(control: TeamProject, engineer: TaskWorker, member: TestUser) {
  const view = openScreen(control, control.project, engineer, member.auth);
  await eventually(() => view.received.join("") === "RFB 003.008\n");
  view.socket.send(new Uint8Array([...new TextEncoder().encode("RFB 003.008\n"), 1, 1]));
  return { ...view, send: (bytes: number[]) => view.socket.send(new Uint8Array(bytes)) };
}
const key = (letter: string) => [4, 1, 0, 0, 0, 0, 0, letter.charCodeAt(0)]; // KeyEvent, key down
const updateRequest = (x: number) => [3, 1, 0, x, 0, 0, 0, 1, 0, 1]; // FramebufferUpdateRequest at x
const text = (bytes: number[]) => new TextDecoder().decode(new Uint8Array(bytes));
// What the engineer's screen received from every viewer, as text.
const screenInput = ({ computers }: TestControl, engineer: TaskWorker) => computers.screenInput.get(engineer.id)?.join("") ?? "";
const screenPath = (project: Project, engineer: TaskWorker, action: "take-over" | "hand-back") => `/projects/${project.id}/workers/${engineer.id}/${action}`;
const errorOf = async (res: Response) => ApiError.parse(await res.json()).error;

test("a member who watches takes control and the engineer's worker waits; hand back returns it to the agent", async () => {
  const control = await teamProject();
  const { project, guest, computers } = control;
  const { engineer } = await runningEngineer(control);
  const worker = () => computers.computers.get(engineer.id)?.worker;
  await viewer(control, engineer, guest);

  const taken = TaskWorker.parse(await (await guest.api("POST", screenPath(project, engineer, "take-over"))).json());
  expect(taken.screenHolder).toBe("octo-friend");
  expect((await engineerOf(control.owner, project, engineer))?.screenHolder).toBe("octo-friend");
  await eventually(() => worker()?.screenControl() === "human");

  await guest.api("POST", screenPath(project, engineer, "hand-back"));
  expect((await engineerOf(control.owner, project, engineer))?.screenHolder).toBeNull();
  await eventually(() => worker()?.screenControl() === "agent");
});

test("one member drives an engineer's screen at a time: another's take-over is refused, and their keys never reach it", async () => {
  const control = await teamProject();
  const { project, owner, guest } = control;
  const { engineer } = await runningEngineer(control);
  // Control is taken from a screen the member has open.
  expect(await errorOf(await guest.api("POST", screenPath(project, engineer, "take-over")))).toBe("screen_not_open");
  const ownerView = await viewer(control, engineer, owner);
  const guestView = await viewer(control, engineer, guest);

  expect((await guest.api("POST", screenPath(project, engineer, "take-over"))).status).toBe(200);
  const refused = await owner.api("POST", screenPath(project, engineer, "take-over"));
  expect(refused.status).toBe(409);
  expect(await errorOf(refused)).toBe("screen_taken");
  expect(await errorOf(await owner.api("POST", screenPath(project, engineer, "hand-back")))).toBe("screen_taken");
  expect((await engineerOf(owner, project, engineer))?.screenHolder).toBe("octo-friend");

  // The owner's key would reach the screen before their update request, on the same stream.
  ownerView.send([...key("o"), ...updateRequest(0x41)]);
  guestView.send(key("g"));
  await eventually(() => screenInput(control, engineer).includes(text(updateRequest(0x41))) && screenInput(control, engineer).includes(text(key("g"))));
  expect(screenInput(control, engineer)).not.toContain(text(key("o")));
});

// The engineers a member's /events socket has said, latest per project.
function watchWorkers({ url }: TestControl, member: TestUser) {
  const socket = new WebSocket(`${url.replace("http", "ws")}/events`, { headers: member.auth });
  atCleanUp(() => socket.close());
  const latest = new Map<ProjectId, TaskWorker[]>();
  socket.onmessage = (event) => {
    const message = ClientEvent.parse(JSON.parse(String(event.data)));
    if (message.type === "workers") latest.set(message.projectId, message.workers);
  };
  return { until: (projectId: ProjectId, check: (workers: TaskWorker[]) => boolean) => eventually(() => check(latest.get(projectId) ?? [])) };
}

test("when the member in control closes their screen, it goes back to the agent and every member is told", async () => {
  const control = await teamProject();
  const { project, owner, guest, computers } = control;
  const { engineer } = await runningEngineer(control);
  const worker = () => computers.computers.get(engineer.id)?.worker;
  const ownerSees = watchWorkers(control, owner);
  const guestView = await viewer(control, engineer, guest);
  await guest.api("POST", screenPath(project, engineer, "take-over"));
  await ownerSees.until(project.id, (workers) => workers.some(({ screenHolder }) => screenHolder === "octo-friend"));

  guestView.socket.close();

  await eventually(() => worker()?.screenControl() === "agent");
  await ownerSees.until(project.id, (workers) => workers.every(({ screenHolder }) => screenHolder === null));
});

// A member following an engineer's transcript on its own socket.
function follow({ url }: TestControl, project: Project, engineer: TaskWorker, member: TestUser) {
  const socket = new WebSocket(`${url.replace("http", "ws")}/projects/${project.id}/workers/${engineer.id}/transcript`, { headers: member.auth });
  atCleanUp(() => socket.close());
  return socket;
}

test("removing a member closes their screen and transcript of every engineer at once, and control they held goes back to the agent", async () => {
  const control = await teamProject();
  const { project, workspace, owner, guest, computers } = control;
  const { engineer } = await runningEngineer(control);
  const worker = () => computers.computers.get(engineer.id)?.worker;
  const guestView = await viewer(control, engineer, guest);
  const transcript = follow(control, project, engineer, guest);
  await eventually(() => transcript.readyState === WebSocket.OPEN);
  await guest.api("POST", screenPath(project, engineer, "take-over"));
  await eventually(() => worker()?.screenControl() === "human");
  const guestId = User.parse(await (await guest.api("GET", "/me")).json()).id;

  await owner.api("DELETE", `/workspaces/${workspace.id}/members/${guestId}`);

  await eventually(() => guestView.socket.readyState === WebSocket.CLOSED && transcript.readyState === WebSocket.CLOSED);
  await eventually(() => worker()?.screenControl() === "agent");
  expect((await engineerOf(owner, project, engineer))?.screenHolder).toBeNull();
});

test("deleting the project closes every member's screens and transcripts of its engineers", async () => {
  const control = await teamProject();
  const { project, owner, guest } = control;
  const { engineer } = await runningEngineer(control);
  const guestView = await viewer(control, engineer, guest);
  const transcript = follow(control, project, engineer, owner);
  await eventually(() => transcript.readyState === WebSocket.OPEN);

  expect((await owner.api("DELETE", `/projects/${project.id}`)).status).toBe(204);

  await eventually(() => guestView.socket.readyState === WebSocket.CLOSED && transcript.readyState === WebSocket.CLOSED);
});

test("a member follows an engineer's transcript: what it did so far, then live, and resumes after the last event it has", async () => {
  const control = await teamProject();
  const { project, guest, signIn, url } = control;
  let finish = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const { engineer } = await runningEngineer(control, async function* () {
    yield sdk.message("msg-1", "Cloned the repo.");
    await finished;
    yield sdk.message("msg-2", "Fixed the typo.");
    yield sdk.idle();
  });
  const texts = (events: ChatEvent[]) => events.flatMap(({ event }) => (event.type === "text-delta" ? [event.text] : []));

  const transcript = guest.watchWorkerTranscript(project.id, engineer.id);
  const sofar = await transcript.until((events) => texts(events).includes("Cloned the repo."));
  const seen = sofar.at(-1)?.seq ?? 0;
  finish();
  const all = await transcript.until((events) => events.some(({ event }) => event.type === "done"));
  expect(texts(all)).toEqual(["Cloned the repo.", "Fixed the typo."]);

  const resumed = await guest.watchWorkerTranscript(project.id, engineer.id, seen).settled();
  expect(resumed.map(({ seq }) => seq)).toEqual(all.filter(({ seq }) => seq > seen).map(({ seq }) => seq));
  const outsider = await signIn({ id: 666, login: "mallory", copilot: null });
  expect((await fetch(`${url}/projects/${project.id}/workers/${engineer.id}/transcript`, { headers: outsider.auth })).status).toBe(404);
});

test("a member reads the project's shared context: the list of files, then one file", async () => {
  const control = await teamProject();
  const { project, guest, signIn, url } = control;
  const { tool } = await heldTurn(control);
  await tool({ tool: "write_context", path: "plans/checkout.md", content: "# Checkout\nTwo steps." });
  await tool({ tool: "write_context", path: "notes.md", content: "Started task #1." });

  const files = ContextFile.array().parse(await (await guest.api("GET", `/projects/${project.id}/context`)).json());
  const file = ContextFileText.parse(await (await guest.api("GET", `/projects/${project.id}/context/file?path=plans/checkout.md`)).json());

  expect(files.map(({ path }) => String(path)).sort()).toEqual(["notes.md", "plans/checkout.md"]);
  expect(file).toEqual({ path: ContextPath.parse("plans/checkout.md"), content: "# Checkout\nTwo steps." });
  expect((await guest.api("GET", `/projects/${project.id}/context/file?path=missing.md`)).status).toBe(404);
  expect((await guest.api("GET", `/projects/${project.id}/context/file?path=../secrets.md`)).status).toBe(400);
  const outsider = await signIn({ id: 666, login: "mallory", copilot: null });
  expect((await fetch(`${url}/projects/${project.id}/context`, { headers: outsider.auth })).status).toBe(404);
});
