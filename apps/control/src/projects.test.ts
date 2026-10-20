import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ApiError, ClientEvent, ContextFile, Project, ProjectSecret, Task, Workspace, WorkspaceInvite, type ChatEvent, type ProjectFileState } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { fakeCopilot, sdk } from "@chiefbot/worker/fake-copilot";
import { fakeClock } from "@chiefbot/worker/clock";
import { atCleanUp, cleanUp, doneCount, eventually, fakeCoordinator, startTestControl, type TestControlOptions, type TestUser } from "./testControl.ts";
import { fakeSecretManager } from "./secrets/fakeSecretManager.ts";
import { secretManagerStore } from "./secrets/secretManager.ts";
import type { SecretStore } from "./secrets/secretStore.ts";

afterEach(cleanUp);

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } };

const projectFile = `# How agents build and test this repo
connectors: [github, jira]
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
  const file = { connectors: ["github", "jira"], commands: { build: "bun run build", test: "bun test" } };
  expect(project).toMatchObject({
    workspaceId: workspace.id,
    name: "shop",
    repo: "octo-org/shop",
    file: { status: "found", file },
    settings: "",
    config: file,
    sources: { connectors: "file", "commands.build": "file", "commands.test": "file" },
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

test("a repo with no project file, or an invalid one, still makes a project, which says so and uses its settings alone", async () => {
  const cases: Array<[Record<string, string>, ProjectFileState["status"], string]> = [
    [{ "README.md": "# Shop" }, "missing", ""],
    [{ "chiefbot.project.yaml": "commands: [unclosed" }, "invalid", "chiefbot.project.yaml: not valid YAML"],
    [{ "chiefbot.project.yaml": "commands:\n  test: 42\n" }, "invalid", "commands.test: Invalid input: expected string, received number"],
    [{ "chiefbot.project.yaml": "conectors: [github]\n" }, "invalid", 'Unrecognized key: "conectors"'],
    // Control reads no more than 64 KB, and keeps a short error.
    [{ "chiefbot.project.yaml": `# ${"x".repeat(64 * 1024)}\n` }, "invalid", "chiefbot.project.yaml: larger than 64 KB"],
    [{ "chiefbot.project.yaml": Array.from({ length: 500 }, (_, key) => `unknown_key_${key}: 1\n`).join("") }, "invalid", "Unrecognized keys"],
  ];
  for (const [files, status, error] of cases) {
    const { createProject, computers } = await team(files);

    const res = await createProject();

    expect(res.status).toBe(201);
    const project = Project.parse(await res.json());
    expect(project.file.status).toBe(status);
    expect(project.file.status === "invalid" ? project.file.error : "").toContain(error);
    expect(project.file.status === "invalid" ? project.file.error.length : 0).toBeLessThanOrEqual(1000);
    expect([project.config.connectors, project.config.commands, project.sources]).toEqual([[], {}, {}]);
    expect(await computers.provider.status(project.id)).toBe("running");
    cleanUp();
  }
});

test("a project whose stored file no longer fits the project file's rules opens as an invalid file: members still edit its settings, and the owner deletes it", async () => {
  const { owner, workspace, createProject, stopControl, startControl, dbPath } = await team(undefined, { persistent: true });
  const project = Project.parse(await (await createProject()).json());
  // As a build from before command limits stored it: the file itself, with a 2,001-character command.
  stopControl();
  const db = new Database(dbPath);
  db.query("UPDATE projects SET file = ?1 WHERE id = ?2").run(JSON.stringify({ connectors: [], commands: { build: "x".repeat(2001) } }), project.id);
  db.close();
  startControl();

  const [listed] = Project.array().parse(await (await owner.api("GET", `/workspaces/${workspace.id}/projects`)).json());

  expect(listed?.file.status).toBe("invalid");
  expect(listed?.file.status === "invalid" && listed.file.error).toContain("commands.build: Too big");
  const saved = await owner.api("PUT", `/projects/${project.id}/settings`, { text: "commands:\n  build: bun run build\n" });
  expect(Project.parse(await saved.json()).config.commands).toEqual({ build: "bun run build" });
  expect((await owner.api("DELETE", `/projects/${project.id}`)).status).toBe(204);
});

test("a repo the member cannot see makes no project", async () => {
  const { createProject, computers, github } = await team();
  github.createRepo("octo-org/hidden", { "README.md": "# Hidden" }, { installed: false });

  for (const repo of ["octo-org/nowhere", "octo-org/hidden"]) {
    const res = await createProject(repo);

    const body = ApiError.parse(await res.json());
    expect([res.status, body.error, body.message]).toEqual([404, "repo_not_found", `${repo} was not found, or your GitHub account cannot see it.`]);
  }
  expect(computers.computers.size).toBe(0);
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

test("a coordinator turn's key reaches only its own project", async () => {
  const control = await teamProject();
  const { url, owner, project, github, createProject } = control;
  github.createRepo("octo-org/api", { "chiefbot.project.yaml": "" });
  const other = Project.parse(await (await createProject("octo-org/api")).json());
  const coordinator = await fakeCoordinator(control, project.id);
  coordinator.hello(null);
  await ask(owner, project, "hold on");
  const { turnKey } = await coordinator.nth("run-turn");
  const listTasks = { method: "POST", body: JSON.stringify({ tool: "list_tasks" }), headers: { authorization: `Bearer ${turnKey}` } };

  const own = await fetch(`${url}/coordinator/${project.id}/tools`, listTasks);
  const crossed = await fetch(`${url}/coordinator/${other.id}/tools`, listTasks);

  expect([own.status, await own.json()]).toEqual([200, []]);
  expect([crossed.status, ApiError.parse(await crossed.json()).error]).toEqual([403, "invalid_turn_key"]);
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

  expect((await ownerChat.until(doneCount(1))).map(({ event }) => event.type)).toEqual(["user-message", "payer", "tool-call", "tool-call", "text-delta", "error", "done"]);
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

test("any member edits the settings: the config takes them key by key, names each key's source, and the coordinator's next turn uses it", async () => {
  const { owner, guest, project, copilot, signIn } = await teamProject();
  const chat = guest.watchProjectChat(project.id);
  await ask(guest, project, "hi");
  await chat.until(doneCount(1));

  const text = "# Ours, not the repo's\ncommands:\n  setup: bun install\n  test: bun run test:unit\nconnectors: []\n";
  const res = await guest.api("PUT", `/projects/${project.id}/settings`, { text });

  expect(res.status).toBe(200);
  const saved = Project.parse(await res.json());
  expect(saved).toMatchObject({
    settings: text,
    config: { connectors: [], commands: { setup: "bun install", build: "bun run build", test: "bun run test:unit" } },
    sources: { connectors: "settings", "commands.setup": "settings", "commands.build": "file", "commands.test": "settings" },
  });
  expect(Project.parse(await (await owner.api("GET", `/projects/${project.id}`)).json())).toEqual(saved);
  await ask(guest, project, "How do I set it up?");
  await chat.until(doneCount(2));
  expect(copilot.instructions.at(-1)).toContain("- setup: bun install");

  // Settings that are not valid change nothing, and say what is wrong.
  const refused = await guest.api("PUT", `/projects/${project.id}/settings`, { text: "workers:\n  max: 0\n" });
  const body = ApiError.parse(await refused.json());
  expect([refused.status, body.error]).toEqual([400, "invalid_settings"]);
  expect(body.message).toContain("workers.max");
  expect(Project.parse(await (await owner.api("GET", `/projects/${project.id}`)).json())).toEqual(saved);
  // Anyone outside the workspace gets 404.
  const stranger = await signIn({ id: 6161, login: "octo-stranger", copilot: null });
  expect((await stranger.api("PUT", `/projects/${project.id}/settings`, { text: "" })).status).toBe(404);
});

test("a member sets, replaces and clears a declared secret, and its value never comes back in a response, event or log", async () => {
  const { url, owner, guest, project, signIn } = await teamProject();
  const values = ["sk-first-value", "sk-second-value"];
  // Every response body, /events message and log line of the test.
  const seen: string[] = [];
  const call = async (member: TestUser, method: string, path: string, body?: unknown) => {
    const res = await member.api(method, `/projects/${project.id}${path}`, body);
    seen.push(await res.clone().text());
    return res;
  };
  const events = new WebSocket(`${url.replace("http", "ws")}/events`, { headers: owner.auth });
  atCleanUp(() => events.close());
  events.onmessage = (message) => seen.push(String(message.data));
  const logs = (["log", "warn", "error"] as const).map((method) => spyOn(console, method));
  atCleanUp(() => logs.forEach((log) => log.mockRestore()));
  const secrets = async () => ProjectSecret.array().parse(await (await call(guest, "GET", "/secrets")).json());

  await call(guest, "PUT", "/settings", { text: "secrets: [API_KEY, DATABASE_URL]\n" });
  expect(await secrets()).toEqual([
    { name: "API_KEY", declared: true, set: false },
    { name: "DATABASE_URL", declared: true, set: false },
  ]);
  expect((await call(guest, "PUT", "/secrets/API_KEY", { value: values[0] })).status).toBe(204);
  expect((await call(owner, "PUT", "/secrets/API_KEY", { value: values[1] })).status).toBe(204);
  expect(await secrets()).toEqual([
    { name: "API_KEY", declared: true, set: true },
    { name: "DATABASE_URL", declared: true, set: false },
  ]);

  // Only a name the config declares takes a value.
  for (const [name, body] of [["OTHER_KEY", { value: "x" }], ["API_KEY", { value: "" }]] as const) {
    const refused = await call(guest, "PUT", `/secrets/${name}`, body);
    expect([refused.status, ApiError.parse(await refused.json()).error]).toEqual([400, "invalid_secret"]);
  }
  // A value whose name the config drops stays, undeclared, until a member clears it.
  await call(owner, "PUT", "/settings", { text: "secrets: [DATABASE_URL]\n" });
  expect(await secrets()).toEqual([
    { name: "DATABASE_URL", declared: true, set: false },
    { name: "API_KEY", declared: false, set: true },
  ]);
  expect((await call(owner, "DELETE", "/secrets/API_KEY")).status).toBe(204);
  expect(await secrets()).toEqual([{ name: "DATABASE_URL", declared: true, set: false }]);
  await call(owner, "GET", "");
  await call(owner, "GET", "/tasks");

  // Nobody outside the workspace sees or sets one.
  const stranger = await signIn({ id: 6161, login: "octo-stranger", copilot: null });
  expect([(await call(stranger, "GET", "/secrets")).status, (await call(stranger, "PUT", "/secrets/DATABASE_URL", { value: "x" })).status]).toEqual([404, 404]);
  const logged = logs.flatMap((log) => log.mock.calls.map((args) => args.map(String).join(" ")));
  for (const value of values) expect([...seen, ...logged].filter((text) => text.includes(value))).toEqual([]);
});

// Control's SecretStore on Secret Manager, over the fake one, as on GCP. For
// project secrets only (users' GitHub tokens are kept there too), it can hold
// each write until released, and fail writes after saving them (as Secret
// Manager can, while destroying old versions) and deletes.
function secretManagerSecrets() {
  const store = secretManagerStore(fakeSecretManager().client);
  const names = new Set<string>();
  let held: Promise<void> | null = null;
  let release = () => {};
  let failing = false;
  let started = 0;
  const projectSecret = (name: string) => name.startsWith("project-");
  const secrets: SecretStore = {
    get: store.get,
    async put(name, value) {
      if (!projectSecret(name)) return store.put(name, value);
      names.add(name);
      started++;
      if (held) await held;
      await store.put(name, value);
      if (failing) throw new Error(`Secret Manager could not destroy an old version after saving ${value}`);
    },
    async delete(name) {
      if (failing && projectSecret(name)) throw new Error("Secret Manager is unavailable");
      await store.delete(name);
    },
  };
  return {
    secrets,
    // Every project secret value the store holds now.
    values: async () => (await Promise.all([...names].map((name) => store.get(name)))).filter((value) => value !== null),
    started: () => started,
    hold() {
      held = new Promise((resolve) => (release = resolve));
    },
    release() {
      held = null;
      release();
    },
    failing(on: boolean) {
      failing = on;
    },
  };
}

test("two members replacing a secret at once leave one value, and a replaced or cleared value leaves the store", async () => {
  const store = secretManagerSecrets();
  const { owner, guest, project } = await teamProject({ secrets: store.secrets });
  const path = `/projects/${project.id}/secrets/API_KEY`;
  await owner.api("PUT", `/projects/${project.id}/settings`, { text: "secrets: [API_KEY]\n" });
  await owner.api("PUT", path, { value: "sk-first" });

  store.hold();
  const replacing = [owner.api("PUT", path, { value: "sk-owner" }), guest.api("PUT", path, { value: "sk-guest" })];
  await eventually(() => store.started() >= 2);
  await Bun.sleep(50);
  store.release();

  expect((await Promise.all(replacing)).map(({ status }) => status)).toEqual([204, 204]);
  const values = await store.values();
  expect(values).toHaveLength(1);
  expect(["sk-owner", "sk-guest"]).toContain(values[0] ?? "");
  expect((await owner.api("DELETE", path)).status).toBe(204);
  expect(await store.values()).toEqual([]);
});

test("a secret the store fails to save keeps its last value, its value stays out of the log, and what the write left goes once the store works again", async () => {
  const store = secretManagerSecrets();
  const { owner, project, restart } = await teamProject({ secrets: store.secrets, persistent: true });
  const secretPath = (name: string) => `/projects/${project.id}/secrets/${name}`;
  await owner.api("PUT", `/projects/${project.id}/settings`, { text: "secrets: [API_KEY, DATABASE_URL]\n" });
  await owner.api("PUT", secretPath("API_KEY"), { value: "sk-kept" });
  const logs = (["log", "warn", "error"] as const).map((method) => spyOn(console, method));
  atCleanUp(() => logs.forEach((log) => log.mockRestore()));

  // The store saves each value, then fails, and fails to delete it too.
  store.failing(true);
  const replaced = await owner.api("PUT", secretPath("API_KEY"), { value: "sk-lost" });
  const first = await owner.api("PUT", secretPath("DATABASE_URL"), { value: "postgres://lost" });

  expect([replaced.status, ApiError.parse(await replaced.json()).error, first.status]).toEqual([503, "secrets_unavailable", 503]);
  expect(ProjectSecret.array().parse(await (await owner.api("GET", `/projects/${project.id}/secrets`)).json())).toEqual([
    { name: "API_KEY", declared: true, set: true },
    { name: "DATABASE_URL", declared: true, set: false },
  ]);
  const logged = logs.flatMap((log) => log.mock.calls.map((args) => args.map(String).join(" ")));
  expect(logged.filter((text) => text.includes("lost"))).toEqual([]);
  expect((await store.values()).sort()).toEqual(["postgres://lost", "sk-kept", "sk-lost"]);

  // Control deletes what the failed writes left when it next starts.
  store.failing(false);
  restart();
  await eventually(async () => (await store.values()).length === 1);
  expect(await store.values()).toEqual(["sk-kept"]);
});

test("a SecretStore error is logged by a known kind and its code, so a crafted error name cannot carry the value", async () => {
  const secrets: SecretStore = {
    get: async () => null,
    put: async (name, value) => {
      if (name.startsWith("project-")) throw Object.assign(new Error("refused"), { name: `Leak ${value}`, code: 14 });
    },
    delete: async () => {},
  };
  const { owner, project } = await teamProject({ secrets });
  await owner.api("PUT", `/projects/${project.id}/settings`, { text: "secrets: [API_KEY]\n" });
  const log = spyOn(console, "error");
  atCleanUp(() => log.mockRestore());

  const res = await owner.api("PUT", `/projects/${project.id}/secrets/API_KEY`, { value: "sk-crafted" });

  expect(res.status).toBe(503);
  const logged = log.mock.calls.map((args) => args.map(String).join(" "));
  expect(logged.filter((text) => text.includes("sk-crafted"))).toEqual([]);
  expect(logged).toContain(`could not save the secret API_KEY of ${project.id}: other 14`);
});

test("deleting a project while a member saves a secret waits for the save, then deletes its value too", async () => {
  const store = secretManagerSecrets();
  const { owner, project, computers } = await teamProject({ secrets: store.secrets });
  await owner.api("PUT", `/projects/${project.id}/settings`, { text: "secrets: [API_KEY]\n" });

  store.hold();
  const saving = owner.api("PUT", `/projects/${project.id}/secrets/API_KEY`, { value: "sk-late" });
  await eventually(() => store.started() === 1);
  const deleting = owner.api("DELETE", `/projects/${project.id}`);
  await eventually(() => computers.destroyed.length === 1);
  await Bun.sleep(50);
  store.release();

  expect([(await saving).status, (await deleting).status]).toEqual([204, 204]);
  expect(await store.values()).toEqual([]);
});

test("deleting a project deletes its settings and its secrets' values", async () => {
  const held = new Map<string, string>();
  const secrets: SecretStore = {
    get: async (name) => held.get(name) ?? null,
    put: async (name, value) => void held.set(name, value),
    delete: async (name) => void held.delete(name),
  };
  const { owner, project, createProject } = await teamProject({ secrets });
  await owner.api("PUT", `/projects/${project.id}/settings`, { text: "secrets: [API_KEY, DATABASE_URL]\n" });
  await owner.api("PUT", `/projects/${project.id}/secrets/API_KEY`, { value: "sk-api-key" });
  await owner.api("PUT", `/projects/${project.id}/secrets/DATABASE_URL`, { value: "postgres://dev" });
  expect([...held.values()]).toEqual(expect.arrayContaining(["sk-api-key", "postgres://dev"]));

  expect((await owner.api("DELETE", `/projects/${project.id}`)).status).toBe(204);

  expect([...held.values()].filter((value) => value === "sk-api-key" || value === "postgres://dev")).toEqual([]);
  // A new project of the same repo starts with no settings and no secrets.
  const again = Project.parse(await (await createProject()).json());
  expect(again.settings).toBe("");
  expect(await (await owner.api("GET", `/projects/${again.id}/secrets`)).json()).toEqual([]);
});
