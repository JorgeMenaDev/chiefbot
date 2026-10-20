import { afterEach, expect, test } from "bun:test";
import { ChatEvent, ClientEvent, Project, TaskWorker, Workspace, WorkspaceInvite, type ProjectId, type ProjectState } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { sdk, type FakeScript } from "@chiefbot/worker/fake-copilot";
import { atCleanUp, cleanUp, eventually, fakeCoordinator, startTestControl, type TestControl, type TestUser } from "./testControl.ts";

// What the desktop's Projects tab reads from control: each project's state dot,
// and a running engineer's screen and transcript.

afterEach(cleanUp);

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } };

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

// The project states a member's /events socket has said, latest per project.
function watchStates({ url }: TestControl, member: TestUser) {
  const socket = new WebSocket(`${url.replace("http", "ws")}/events`, { headers: member.auth });
  atCleanUp(() => socket.close());
  const states = new Map<ProjectId, ProjectState>();
  socket.onmessage = (event) => {
    const message = ClientEvent.parse(JSON.parse(String(event.data)));
    if (message.type === "project-state") states.set(message.projectId, message.state);
  };
  return { until: (projectId: ProjectId, state: ProjectState) => eventually(() => states.get(projectId) === state) };
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

test("a member takes control of an engineer's screen and its worker waits; hand back returns it to the agent", async () => {
  const control = await teamProject();
  const { project, guest, computers } = control;
  const { engineer } = await runningEngineer(control);
  const worker = () => computers.computers.get(engineer.id)?.worker;

  const taken = TaskWorker.parse(await (await guest.api("POST", `/projects/${project.id}/workers/${engineer.id}/take-over`)).json());
  expect(taken.screenControl).toBe("human");
  expect((await engineerOf(control.owner, project, engineer))?.screenControl).toBe("human");
  await eventually(() => worker()?.screenControl() === "human");

  await guest.api("POST", `/projects/${project.id}/workers/${engineer.id}/hand-back`);
  expect((await engineerOf(control.owner, project, engineer))?.screenControl).toBe("agent");
  await eventually(() => worker()?.screenControl() === "agent");
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
