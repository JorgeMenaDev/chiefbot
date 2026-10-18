import { afterEach, expect, test } from "bun:test";
import { Handoff, Project, Task, User, Workspace, WorkspaceInvite, type ChatEvent } from "@chiefbot/contracts";
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

// The notices control posted in a chief's chat.
const notices = (events: ChatEvent[]) => events.flatMap(({ event }) => (event.type === "handoff-update" ? [event] : []));

test("the chief is told once per transition when its task needs input or is done, and about no other task", async () => {
  const { owner, guest, project, chief, copilot } = await setup();
  // The coordinator's turns move task #1 through these statuses, one turn per line.
  const moves: Array<Array<{ number: number; status: string; links?: Array<{ kind: string; url: string }> }>> = [
    [{ number: 1, status: "needs_input" }, { number: 1, status: "needs_input" }],
    [{ number: 1, status: "in_progress" }, { number: 2, status: "needs_input" }],
    [{ number: 1, status: "needs_input" }],
    [
      { number: 1, status: "done", links: [{ kind: "pull-request", url: "https://github.com/octo-org/shop/pull/7" }] },
      { number: 1, status: "done" },
    ],
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

  await eventually(() => notices(chiefChat.events).length >= 3);
  await Bun.sleep(50);
  const expected = [
    ["needs_input", 'shop needs your input on "Add a checkout page" (task #1). Answer in the project\'s chat.'],
    ["needs_input", 'shop needs your input on "Add a checkout page" (task #1). Answer in the project\'s chat.'],
    ["done", 'shop finished "Add a checkout page" (task #1): https://github.com/octo-org/shop/pull/7'],
  ];
  expect(notices(chiefChat.events).map(({ status, text }) => [status, text])).toEqual(expected);
  // They are stored in the chief's chat history, so a desktop that was closed sees them too.
  expect(notices((await owner.watchChat(chief.id).settled())).map(({ status, text }) => [status, text])).toEqual(expected);
});

test("a notice a crash kept from the chief reaches it when control starts again", async () => {
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

  const chat = await owner.watchChat(chief.id).until((events) => notices(events).length > 0);
  expect(notices(chat).map(({ status, text }) => [status, text])).toEqual([["done", 'shop finished "Add a checkout page" (task #1).']]);
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
