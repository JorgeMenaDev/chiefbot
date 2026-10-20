import { afterEach, expect, test } from "bun:test";
import { ApiError, Handoff, Project, Task, TaskWorker, User, Workspace, WorkspaceInvite, type ChatEvent } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { sdk } from "@chiefbot/worker/fake-copilot";
import { Database } from "bun:sqlite";
import { cleanUp, doneCount, eventually, startTestControl, type TestControlOptions, type TestUser } from "./testControl.ts";

// A person's chief of staff (their personal bot) hands work to a project of
// their workspace and watches it. End to end: control, a fake GitHub, the
// chief's real worker and the project's real coordinator, both on one fake Copilot.

afterEach(cleanUp);

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } };

// Control with a workspace owned by the signed-in user (octo-user), octo-friend
// as its member, a project for octo-org/shop, and the owner's chief online.
async function setup(options: TestControlOptions = {}) {
  const control = await startTestControl(options);
  const owner = control.user;
  const workspace = Workspace.parse(await (await owner.api("POST", "/workspaces", { name: "Platform team" })).json());
  await owner.api("POST", `/workspaces/${workspace.id}/invites`, { login: friend.login });
  const guest = await control.signIn(friend);
  const [invite] = WorkspaceInvite.array().parse(await (await guest.api("GET", "/invites")).json());
  await guest.api("POST", `/invites/${invite?.id}/accept`);
  control.github.createRepo("octo-org/shop", { "chiefbot.project.yaml": "" });
  const project = Project.parse(await (await owner.api("POST", `/workspaces/${workspace.id}/projects`, { repo: "octo-org/shop" })).json());
  const chief = await owner.onlineBot("Chief");
  return { ...control, owner, guest, project, chief };
}

// What a chief tool answered: its JSON, or the refusal's message.
const answer = (call: Promise<{ result: unknown }>) =>
  call.then(
    ({ result }): unknown => JSON.parse(String(result)),
    (error: Error) => ({ refused: error.message }),
  );

const tasksOf = async (member: TestUser, project: Project) =>
  Task.array().parse(await (await member.api("GET", `/projects/${project.id}/tasks`)).json());

const workersOf = async (member: TestUser, project: Project) =>
  TaskWorker.array().parse(await (await member.api("GET", `/projects/${project.id}/workers`)).json());

// The chief's request for a checkout page, as a model would make it.
const checkout = (project: Project) => ({
  project: project.id,
  title: "Add a checkout page",
  request: "Customers need to pay for what is in their cart.",
  acceptance: "A pull request with a checkout page that takes a test card",
});

test("a chief hands work to a project: the coordinator gets it as a ledger task in the requester's chat, and its status follows the ledger", async () => {
  const { owner, project, chief, copilot } = await setup();
  const answers: unknown[] = [];
  // The chief lists projects and sends; the coordinator starts on the task it gets.
  copilot.script = async function* (prompt, runtime) {
    if (prompt === "hand off the checkout") {
      answers.push(await answer(runtime.tool("list_projects", {})));
      answers.push(await answer(runtime.tool("send_to_project", checkout(project))));
    } else if (prompt.includes("task #1")) {
      await runtime.tool("update_task", { number: 1, status: "in_progress" });
    } else {
      answers.push(await answer(runtime.tool("handoff_status", {})));
    }
    yield sdk.idle();
  };

  await owner.send(chief.id, "hand off the checkout");
  await owner.watchChat(chief.id).until(doneCount(1));
  const coordinatorChat = await owner.watchProjectChat(project.id).until(doneCount(1));
  await owner.send(chief.id, "how is the checkout going?");
  await owner.watchChat(chief.id).until(doneCount(2));

  expect(Project.array().parse(answers[0])).toEqual([project]);
  const sent = Handoff.parse(answers[1]);
  expect(sent).toMatchObject({
    projectId: project.id,
    project: "shop",
    requestedBy: "octo-user",
    request: "Customers need to pay for what is in their cart.",
    acceptance: "A pull request with a checkout page that takes a test card",
    status: "open",
    taskNumber: 1,
  });
  expect(await tasksOf(owner, project)).toMatchObject([
    {
      number: 1,
      title: "Add a checkout page",
      detail: "Customers need to pay for what is in their cart.\n\nDone when: A pull request with a checkout page that takes a test card",
      status: "in_progress",
      requestedBy: "octo-user",
    },
  ]);
  // The handoff reaches the coordinator as a turn in the requester's own chat with it.
  const [handed] = coordinatorChat.flatMap(({ event }) => (event.type === "user-message" ? [event.text] : []));
  expect(handed).toContain("octo-user's chief of staff");
  expect(handed).toContain("task #1");
  expect(handed).toContain("Done when: A pull request with a checkout page that takes a test card");
  expect(Handoff.array().parse(answers[2])).toEqual([{ ...sent, status: "in_progress" }]);
});

// The user messages of a member's chat with the coordinator.
const sentToCoordinator = (events: ChatEvent[]) => events.flatMap(({ event }) => (event.type === "user-message" ? [event.text] : []));

test("a chief's follow-up lands on the same task and in the same chat, once however often it is delivered", async () => {
  const { owner, project, chief, copilot } = await setup();
  const answers: unknown[] = [];
  copilot.script = async function* (prompt, runtime) {
    if (prompt === "hand off the checkout") {
      const handoff = Handoff.parse(await answer(runtime.tool("send_to_project", checkout(project))));
      const followUp = { handoff: handoff.id, message: "Also take PayPal." };
      // The runtime delivers the same call twice (a resume resends it).
      answers.push(await answer(runtime.tool("message_project", followUp, "call-again")));
      answers.push(await answer(runtime.tool("message_project", followUp, "call-again")));
    }
    yield sdk.idle();
  };

  await owner.send(chief.id, "hand off the checkout");
  await owner.watchChat(chief.id).until(doneCount(1));
  const coordinatorChat = await owner.watchProjectChat(project.id).until(doneCount(2));
  await Bun.sleep(50);

  expect(answers.map((sent) => Handoff.parse(sent).taskNumber)).toEqual([1, 1]);
  const [task, ...others] = await tasksOf(owner, project);
  expect(others).toEqual([]);
  expect(task?.detail).toEndWith("Follow-up from octo-user's chief of staff: Also take PayPal.");
  const sent = sentToCoordinator(await owner.watchProjectChat(project.id).settled());
  expect(sent).toHaveLength(2);
  expect(sent[1]).toStartWith("About task #1, from your chief of staff:");
  expect(sent[1]).toContain("Also take PayPal.");
  expect(sentToCoordinator(coordinatorChat)).toEqual(sent);
});

test("the owner answers the project's question from the chief's card: it reaches the same task and chat once, and its delivery id carries no other answer", async () => {
  const { owner, guest, project, chief, copilot } = await setup();
  copilot.script = async function* (prompt, runtime) {
    if (prompt === "hand off the checkout") await runtime.tool("send_to_project", checkout(project));
    else if (prompt.includes("task #1 in the ledger")) await runtime.tool("update_task", { number: 1, status: "needs_input", question: "Stripe or Adyen?" });
    yield sdk.idle();
  };
  const otherBot = await owner.onlineBot("Another bot");
  await owner.send(chief.id, "hand off the checkout");
  const chiefChat = await owner.watchChat(chief.id).until((events) => cards(events).some(({ stage }) => stage === "needs_input"));
  const card = cards(chiefChat).at(-1);
  if (!card) throw new Error("no card");
  await owner.watchProjectChat(project.id).until(doneCount(1));

  const reply = { text: "Stripe.", question: "Stripe or Adyen?", deliveryId: crypto.randomUUID() };
  const replies = [
    await owner.api("POST", `/bots/${chief.id}/handoffs/${card.handoffId}/messages`, reply),
    await owner.api("POST", `/bots/${chief.id}/handoffs/${card.handoffId}/messages`, reply),
    // An edited answer, or the same one to another question, under the delivery id of one control already has.
    await owner.api("POST", `/bots/${chief.id}/handoffs/${card.handoffId}/messages`, { ...reply, text: "Adyen instead." }),
    await owner.api("POST", `/bots/${chief.id}/handoffs/${card.handoffId}/messages`, { ...reply, question: "Which payment provider?" }),
    await owner.api("POST", `/bots/${otherBot.id}/handoffs/${card.handoffId}/messages`, { ...reply, deliveryId: crypto.randomUUID() }),
    await guest.api("POST", `/bots/${chief.id}/handoffs/${card.handoffId}/messages`, { ...reply, deliveryId: crypto.randomUUID() }),
  ];
  const projectChat = await owner.watchProjectChat(project.id).until(doneCount(2));
  await Bun.sleep(50);

  expect(card).toMatchObject({ stage: "needs_input", question: "Stripe or Adyen?" });
  expect(replies.map(({ status }) => status)).toEqual([204, 204, 409, 409, 404, 404]);
  for (const refused of replies.slice(2, 4)) expect(ApiError.parse(await refused.json()).error).toBe("delivery_reused");
  const sent = sentToCoordinator(projectChat);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe("About task #1, your answer from your chief of staff's chat:\n\nStripe.");
  const [task, ...others] = await tasksOf(owner, project);
  expect(others).toEqual([]);
  expect(task?.detail).toEndWith('octo-user answered "Stripe or Adyen?": Stripe.');
});

test("an answer to a question the project no longer asks is refused, and reaches nothing", async () => {
  const { owner, project, chief, copilot } = await setup();
  copilot.script = async function* (prompt, runtime) {
    if (prompt === "hand off the checkout") await runtime.tool("send_to_project", checkout(project));
    else if (prompt.includes("task #1 in the ledger")) {
      await runtime.tool("update_task", { number: 1, status: "needs_input", question: "Stripe or Adyen?" });
      await runtime.tool("update_task", { number: 1, status: "needs_input", question: "Which production region?" });
    }
    yield sdk.idle();
  };
  await owner.send(chief.id, "hand off the checkout");
  await owner.watchChat(chief.id).until(doneCount(1));
  await owner.watchProjectChat(project.id).until(doneCount(1));
  const handoffId = cards(await owner.watchChat(chief.id).settled()).at(-1)?.handoffId;

  const messages = `/bots/${chief.id}/handoffs/${handoffId}/messages`;
  // The owner answers the question their card showed before the project changed it.
  const stale = await owner.api("POST", messages, { text: "Stripe.", question: "Stripe or Adyen?", deliveryId: crypto.randomUUID() });
  const current = await owner.api("POST", messages, { text: "eu-west.", question: "Which production region?", deliveryId: crypto.randomUUID() });
  const projectChat = await owner.watchProjectChat(project.id).until(doneCount(2));

  expect(stale.status).toBe(409);
  expect(ApiError.parse(await stale.json())).toEqual({ error: "question_changed", message: "shop now asks: Which production region?" });
  expect(current.status).toBe(204);
  expect(sentToCoordinator(projectChat).slice(1)).toEqual(["About task #1, your answer from your chief of staff's chat:\n\neu-west."]);
  const [task] = await tasksOf(owner, project);
  expect(task?.detail).not.toContain("Stripe.");
  expect(task?.detail).toEndWith('octo-user answered "Which production region?": eu-west.');
});

test("while the project asks a question, a chief's message names it: one naming an older question, or none, is refused", async () => {
  const { owner, project, chief, copilot } = await setup();
  const answers: unknown[] = [];
  const handoffs: Handoff[] = [];
  copilot.script = async function* (prompt, runtime) {
    if (prompt === "hand off the checkout") handoffs.push(Handoff.parse(await answer(runtime.tool("send_to_project", checkout(project)))));
    else if (prompt.includes("task #1 in the ledger")) {
      await runtime.tool("update_task", { number: 1, status: "needs_input", question: "Stripe or Adyen?" });
      await runtime.tool("update_task", { number: 1, status: "needs_input", question: "Which production region?" });
    } else if (prompt === "answer the project") {
      const handoff = handoffs[0]?.id ?? null;
      // The chief read the first question; the project asks another by now.
      answers.push(await answer(runtime.tool("message_project", { handoff, message: "Stripe.", question: "Stripe or Adyen?" })));
      answers.push(await answer(runtime.tool("message_project", { handoff, message: "Also take PayPal." })));
      answers.push(await answer(runtime.tool("message_project", { handoff, message: "eu-west.", question: "Which production region?" })));
    }
    yield sdk.idle();
  };
  await owner.send(chief.id, "hand off the checkout");
  await owner.watchChat(chief.id).until(doneCount(1));
  await owner.watchProjectChat(project.id).until(doneCount(1));
  await owner.send(chief.id, "answer the project");
  await owner.watchChat(chief.id).until(doneCount(2));
  const projectChat = await owner.watchProjectChat(project.id).until(doneCount(2));

  const refusal = { refused: "shop now asks: Which production region?" };
  expect(answers.slice(0, 2)).toEqual([refusal, refusal]);
  expect(Handoff.parse(answers[2]).taskNumber).toBe(1);
  expect(sentToCoordinator(projectChat).slice(1)).toEqual(["About task #1, from your chief of staff:\n\neu-west."]);
  const [task] = await tasksOf(owner, project);
  expect(task?.detail).not.toContain("Stripe.");
  expect(task?.detail).not.toContain("PayPal");
  expect(task?.detail).toEndWith(`octo-user's chief of staff answered "Which production region?": eu-west.`);
});

test("a follow-up to a handoff whose task is done is refused: new work is a new handoff", async () => {
  const { owner, project, chief, copilot } = await setup();
  const answers: unknown[] = [];
  const handoffs: Handoff[] = [];
  copilot.script = async function* (prompt, runtime) {
    if (prompt === "hand off the checkout") handoffs.push(Handoff.parse(await answer(runtime.tool("send_to_project", checkout(project)))));
    else if (prompt.includes("task #1 in the ledger")) await runtime.tool("update_task", { number: 1, status: "done" });
    else if (prompt === "also take PayPal") answers.push(await answer(runtime.tool("message_project", { handoff: handoffs[0]?.id ?? null, message: "Also take PayPal." })));
    yield sdk.idle();
  };
  await owner.send(chief.id, "hand off the checkout");
  await owner.watchChat(chief.id).until((events) => cards(events).some(({ stage }) => stage === "done"));
  await owner.send(chief.id, "also take PayPal");
  await owner.watchChat(chief.id).until(doneCount(2));
  const fromCard = await owner.api("POST", `/bots/${chief.id}/handoffs/${handoffs[0]?.id}/messages`, { text: "PayPal too.", question: null, deliveryId: crypto.randomUUID() });
  await Bun.sleep(50);

  expect(answers).toEqual([{ refused: "Task #1 in shop is done: hand over new work with send_to_project" }]);
  expect(fromCard.status).toBe(409);
  expect(ApiError.parse(await fromCard.json()).error).toBe("handoff_closed");
  expect(sentToCoordinator(await owner.watchProjectChat(project.id).settled())).toHaveLength(1);
  const [task] = await tasksOf(owner, project);
  expect(task?.detail).not.toContain("PayPal");
});

test("handoff_status says what the project asks, its workers, its pull requests and the coordinator's last reply about it, in a turn its worker's ending started too", async () => {
  const { owner, project, chief, copilot } = await setup();
  const pullRequest = "https://github.com/octo-org/shop/pull/7";
  const answers: unknown[] = [];
  copilot.script = async function* (prompt, runtime) {
    if (prompt === "hand off the checkout") await runtime.tool("send_to_project", checkout(project));
    else if (/^Task #1:/m.test(prompt)) yield sdk.message("w-1", "Opened the pull request.");
    else if (prompt.includes("task #1 in the ledger")) {
      await runtime.tool("dispatch_worker", { task: 1 });
      await runtime.tool("update_task", { number: 1, status: "needs_input", question: "Stripe or Adyen?", links: [{ kind: "pull-request", url: pullRequest }] });
      yield sdk.message("c-1", "A worker opened a pull request. Stripe or Adyen?");
    } else if (prompt.startsWith("Engineer for task #1 ended:")) yield sdk.message("c-3", "The engineer finished. I still need: Stripe or Adyen?");
    else if (prompt === "a question of my own") yield sdk.message("c-2", "About something else entirely.");
    else if (prompt === "how is it going?") answers.push(await answer(runtime.tool("handoff_status", {})));
    yield sdk.idle();
  };
  await owner.send(chief.id, "hand off the checkout");
  await owner.watchChat(chief.id).until(doneCount(1));
  await owner.watchProjectChat(project.id).until(doneCount(1));
  await eventually(async () => (await workersOf(owner, project)).some(({ state }) => state === "finished"));
  // The worker's ending wakes the coordinator about the task. Its reply to a message of the member's own is not about it.
  await owner.watchProjectChat(project.id).until(doneCount(2));
  await owner.api("POST", `/projects/${project.id}/messages`, { text: "a question of my own" });
  await owner.watchProjectChat(project.id).until(doneCount(3));

  await owner.send(chief.id, "how is it going?");
  await owner.watchChat(chief.id).until(doneCount(2));

  const [worker] = await workersOf(owner, project);
  expect(Handoff.array().parse(answers[0])).toMatchObject([
    {
      status: "needs_input",
      question: "Stripe or Adyen?",
      links: [{ kind: "pull-request", url: pullRequest }],
      workers: [{ id: worker?.id, state: "finished", result: "Opened the pull request.", pullRequest: null }],
      summary: "The engineer finished. I still need: Stripe or Adyen?",
    },
  ]);
});

// The handoff cards control posted in a chief's chat, oldest first.
const cards = (events: ChatEvent[]) => events.flatMap(({ event }) => (event.type === "handoff-card" ? [event.card] : []));

test("the chief's chat has one card per handoff that follows its task, posted once per change and about no other task", async () => {
  const { owner, guest, project, chief, copilot } = await setup();
  const pullRequest = "https://github.com/octo-org/shop/pull/7";
  // The coordinator's turns move task #1 through these, one turn per line.
  const moves: Array<Array<{ number: number; status: string; question?: string; links?: Array<{ kind: string; url: string }> }>> = [
    [{ number: 1, status: "in_progress" }],
    [
      { number: 1, status: "needs_input", question: "Stripe or Adyen?" },
      { number: 1, status: "needs_input" },
    ],
    [{ number: 2, status: "needs_input", question: "Which footer?" }],
    [{ number: 1, status: "in_progress", links: [{ kind: "pull-request", url: pullRequest }] }],
  ];
  copilot.script = async function* (prompt, runtime) {
    if (prompt === "hand off the checkout") await runtime.tool("send_to_project", checkout(project));
    else if (prompt === "a task of its own") await runtime.tool("create_task", { title: "Fix the footer" });
    else if (prompt.startsWith("move ")) for (const move of moves[Number(prompt.slice(5))] ?? []) await runtime.tool("update_task", move);
    yield sdk.idle();
  };
  const chiefChat = owner.watchChat(chief.id);
  await owner.send(chief.id, "hand off the checkout");
  await chiefChat.until(doneCount(1));
  await owner.watchProjectChat(project.id).until(doneCount(1));
  // octo-friend's own task #2, with no handoff.
  await guest.api("POST", `/projects/${project.id}/messages`, { text: "a task of its own" });
  await guest.watchProjectChat(project.id).until(doneCount(1));

  for (const [index] of moves.entries()) {
    await owner.api("POST", `/projects/${project.id}/messages`, { text: `move ${index}` });
    await owner.watchProjectChat(project.id).until(doneCount(index + 2));
  }
  // Nobody verified the pull request, so a member marks the task done in the app; a second time changes nothing.
  for (const status of [200, 409]) expect((await owner.api("POST", `/projects/${project.id}/tasks/1/done`)).status).toBe(status);

  await eventually(() => cards(chiefChat.events).length >= 5);
  await Bun.sleep(50);
  const card = { projectId: project.id, workspaceId: project.workspaceId, project: "shop", title: "Add a checkout page", taskNumber: 1 };
  const expected = [
    { ...card, stage: "accepted", question: null, pullRequests: [] },
    { ...card, stage: "working", question: null, pullRequests: [] },
    { ...card, stage: "needs_input", question: "Stripe or Adyen?", pullRequests: [] },
    { ...card, stage: "pr_opened", question: null, pullRequests: [pullRequest] },
    { ...card, stage: "done", question: null, pullRequests: [pullRequest] },
  ];
  expect(cards(chiefChat.events)).toMatchObject(expected);
  expect(new Set(cards(chiefChat.events).map(({ handoffId }) => handoffId)).size).toBe(1);
  // They are stored in the chief's chat history, so a desktop that was closed sees them too.
  expect(cards(await owner.watchChat(chief.id).settled())).toEqual(cards(chiefChat.events));
});

test("a handoff's card and handoff_status show its task's verdict: Verified PASS at a commit, then stale once the pull request moves", async () => {
  const { owner, project, chief, copilot, github } = await setup();
  const head = github.commit("octo-org/shop", { "checkout.html": "<form></form>\n" }, "checkout");
  const pullRequest = github.openPullRequest("octo-org/shop", { head: "checkout", title: "Add a checkout page" });
  const answers: unknown[] = [];
  copilot.script = async function* (prompt, runtime) {
    if (prompt.startsWith("You are the verifier")) await runtime.tool("report_verdict", { result: "pass", summary: "The checkout takes a test card." });
    else if (prompt === "hand off the checkout") await runtime.tool("send_to_project", checkout(project));
    else if (prompt.includes("task #1 in the ledger")) {
      await runtime.tool("update_task", { number: 1, status: "in_progress", links: [{ kind: "pull-request", url: pullRequest }] });
      await runtime.tool("dispatch_verifier", { task: 1 });
    } else if (prompt === "Mark task #1 done.") answers.push(await answer(runtime.tool("update_task", { number: 1, status: "done" })));
    else if (prompt === "how is it going?") answers.push(await answer(runtime.tool("handoff_status", {})));
    yield sdk.idle();
  };
  const chiefChat = owner.watchChat(chief.id);
  await owner.send(chief.id, "hand off the checkout");
  await chiefChat.until(doneCount(1));
  await eventually(() => cards(chiefChat.events).length === 3);
  // The pull request moves outside Chiefbot; the coordinator's done finds it.
  const moved = github.commit("octo-org/shop", { "checkout.html": "<form>pay</form>\n" }, "checkout");
  await owner.api("POST", `/projects/${project.id}/messages`, { text: "Mark task #1 done." });
  await eventually(() => cards(chiefChat.events).length === 4);
  await owner.send(chief.id, "how is it going?");
  await chiefChat.until(doneCount(2));

  const verdict = { result: "pass" as const, sha: head, testsOnly: true, summary: "The checkout takes a test card." };
  expect(cards(chiefChat.events).map(({ stage, verification }) => [stage, verification])).toEqual([
    ["accepted", null],
    ["pr_opened", null],
    ["verified", { ...verdict, stale: false }],
    ["pr_opened", { ...verdict, stale: true }],
  ]);
  expect(answers[0]).toMatchObject({ refused: expect.stringContaining(`has moved to ${moved.slice(0, 7)}`) });
  expect(Handoff.array().parse(answers[1])).toMatchObject([{ status: "in_progress", verification: { ...verdict, stale: true } }]);
});

test("handoff_status re-reads the pull request on GitHub: a push from outside Chiefbot makes the PASS stale, and the card says so", async () => {
  const { owner, project, chief, copilot, github } = await setup();
  const head = github.commit("octo-org/shop", { "checkout.html": "<form></form>\n" }, "checkout");
  const pullRequest = github.openPullRequest("octo-org/shop", { head: "checkout", title: "Add a checkout page" });
  const answers: unknown[] = [];
  copilot.script = async function* (prompt, runtime) {
    if (prompt.startsWith("You are the verifier")) await runtime.tool("report_verdict", { result: "pass", summary: "The checkout takes a test card." });
    else if (prompt === "hand off the checkout") await runtime.tool("send_to_project", checkout(project));
    else if (prompt.includes("task #1 in the ledger")) {
      await runtime.tool("update_task", { number: 1, status: "in_progress", links: [{ kind: "pull-request", url: pullRequest }] });
      await runtime.tool("dispatch_verifier", { task: 1 });
    } else if (prompt === "how is it going?") answers.push(await answer(runtime.tool("handoff_status", {})));
    yield sdk.idle();
  };
  const chiefChat = owner.watchChat(chief.id);
  await owner.send(chief.id, "hand off the checkout");
  await chiefChat.until(doneCount(1));
  await eventually(() => cards(chiefChat.events).at(-1)?.stage === "verified");

  github.commit("octo-org/shop", { "checkout.html": "<form>pay</form>\n" }, "checkout");
  await owner.send(chief.id, "how is it going?");
  await chiefChat.until(doneCount(2));

  const stale = { result: "pass" as const, sha: head, stale: true, testsOnly: true, summary: "The checkout takes a test card." };
  expect(Handoff.array().parse(answers[0])).toMatchObject([{ status: "in_progress", verification: stale }]);
  await eventually(() => cards(chiefChat.events).at(-1)?.stage === "pr_opened");
  expect(cards(chiefChat.events).at(-1)?.verification).toEqual(stale);
});

test("a card change a crash kept from the chief reaches it when control starts again", async () => {
  const { owner, project, chief, copilot, dbPath, stopControl, startControl } = await setup({ persistent: true });
  copilot.script = async function* (prompt, runtime) {
    if (prompt === "hand off the checkout") await runtime.tool("send_to_project", checkout(project));
    yield sdk.idle();
  };
  await owner.send(chief.id, "hand off the checkout");
  await owner.watchChat(chief.id).until(doneCount(1));
  await owner.watchProjectChat(project.id).until(doneCount(1));

  // Control stops right after storing the task's move to done, before telling the chief.
  stopControl();
  const db = new Database(dbPath);
  db.run("UPDATE project_tasks SET status = 'done' WHERE number = 1");
  db.close();
  startControl();

  const chat = await owner.watchChat(chief.id).until((events) => cards(events).length > 1);
  expect(cards(chat).map(({ stage }) => stage)).toEqual(["accepted", "done"]);
});

test("a handoff from before cards gets no card when control upgrades, and gets one when its task next changes", async () => {
  const { owner, project, chief, copilot, dbPath, stopControl, startControl } = await setup({ persistent: true });
  copilot.script = async function* (prompt, runtime) {
    if (prompt === "hand off the checkout") await runtime.tool("send_to_project", checkout(project));
    yield sdk.idle();
  };
  await owner.send(chief.id, "hand off the checkout");
  await owner.watchChat(chief.id).until(doneCount(1));
  await owner.watchProjectChat(project.id).until(doneCount(1));

  // Back to the table as it was before cards: its task's status watched, no card.
  stopControl();
  const old = new Database(dbPath);
  old.run("ALTER TABLE handoffs ADD COLUMN watched_status TEXT NOT NULL DEFAULT 'open'");
  old.run("UPDATE handoffs SET watched_card = NULL");
  old.run("UPDATE project_tasks SET status = 'in_progress' WHERE number = 1");
  old.close();
  startControl();
  const upgraded = cards(await owner.watchChat(chief.id).settled()).map(({ stage }) => stage);
  copilot.script = async function* (_prompt, runtime) {
    await runtime.tool("update_task", { number: 1, status: "done" });
    yield sdk.idle();
  };
  await owner.api("POST", `/projects/${project.id}/messages`, { text: "Mark task #1 done." });
  const chat = await owner.watchChat(chief.id).until((events) => cards(events).length > 1);

  expect(upgraded).toEqual(["accepted"]);
  expect(cards(chat).map(({ stage }) => stage)).toEqual(["accepted", "done"]);
});

test("a chief sees and reaches only projects of its owner's workspaces", async () => {
  const { url, owner, guest, project, copilot, signIn, computers } = await setup();
  const stranger = await signIn({ id: 6161, login: "octo-stranger", copilot: null });
  const strangersChief = await stranger.onlineBot("Stranger's chief");
  const guestsChief = await guest.onlineBot("Friend's chief");
  const answers: unknown[] = [];
  copilot.script = async function* (prompt, runtime) {
    if (prompt === "try") {
      answers.push(await answer(runtime.tool("list_projects", {})), await answer(runtime.tool("send_to_project", checkout(project))));
    } else if (prompt === "send") await runtime.tool("send_to_project", checkout(project));
    else if (prompt === "status") answers.push(await answer(runtime.tool("handoff_status", {})));
    yield sdk.idle();
  };

  await stranger.send(strangersChief.id, "try");
  await stranger.watchChat(strangersChief.id).until(doneCount(1));
  // A bot's credential works for its own bot only.
  const crossed = await fetch(`${url}/worker/${guestsChief.id}/chief-tools`, {
    method: "POST",
    headers: { authorization: `Bearer ${computers.computers.get(strangersChief.id)?.spec.env.CHIEFBOT_BOT_TOKEN}` },
    body: JSON.stringify({ tool: "list_projects" }),
  });
  // A member's chief hands off, then the member leaves the workspace.
  await guest.send(guestsChief.id, "send");
  await guest.watchChat(guestsChief.id).until(doneCount(1));
  const guestId = User.parse(await (await guest.api("GET", "/me")).json()).id;
  await guest.api("DELETE", `/workspaces/${project.workspaceId}/members/${guestId}`);
  await guest.send(guestsChief.id, "status");
  await guest.watchChat(guestsChief.id).until(doneCount(2));

  expect(answers.slice(0, 2)).toEqual([[], { refused: `No project ${project.id} in your owner's workspaces` }]);
  expect(crossed.status).toBe(403);
  // Only the member's handoff reached the ledger; once they left, their chief sees it no more.
  expect((await tasksOf(owner, project)).map(({ requestedBy }) => requestedBy)).toEqual(["octo-friend"]);
  expect(answers[2]).toEqual([]);
});
