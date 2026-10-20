import { afterEach, expect, test } from "bun:test";
import { Handoff, Project, Task, TaskWorker, Workspace, type ChatEvent } from "@chiefbot/contracts";
import { setupShell } from "@chiefbot/worker/engineer-setup";
import { fakeCopilot, sdk } from "@chiefbot/worker/fake-copilot";
import { gitProxyConfig } from "@chiefbot/worker/git-proxy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atCleanUp, cleanUp, doneCount, eventually, startTestControl, type TestUser } from "./testControl.ts";

// The README's manual check "a chief's request ends in a verified PR", offline:
// control, a fake GitHub, and fake computers whose chief, coordinator, engineer
// and verifier all run on one fake Copilot. The engineer's and verifier's
// setups and shells run real git, reaching the fake GitHub only through
// control's git proxy, as in a real computer.

afterEach(cleanUp);

// Control with a persistent database whose computers run real git, and the
// owner's workspace (octo-user).
async function gitControl() {
  const home = mkdtempSync(join(tmpdir(), "chiefbot-home-"));
  atCleanUp(() => rmSync(home, { recursive: true, force: true }));
  // Short: a unix socket path must fit in about 100 bytes.
  const socket = `/tmp/chiefbot-e2e-${crypto.randomUUID().slice(0, 8)}.sock`;
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
  const control = await startTestControl({ persistent: true, copilot: fakeCopilot({ shell: { cwd: home, env } }), setupShell: setupShell(env), gitSocket: socket });
  const helper = join(import.meta.dir, "../../worker/src/gitCredential.ts");
  Object.assign(env, gitProxyConfig({ controlUrl: control.url, helper: `"${process.execPath}" ${helper}` }));
  const owner = control.user;
  const workspace = Workspace.parse(await (await owner.api("POST", "/workspaces", { name: "Platform team" })).json());
  return { ...control, owner, workspace };
}

// The handoff cards control posted in a chief's chat, oldest first.
const cards = (events: ChatEvent[]) => events.flatMap(({ event }) => (event.type === "handoff-card" ? [event.card] : []));

// The user messages of a member's chat with the coordinator.
const sentToCoordinator = (events: ChatEvent[]) => events.flatMap(({ event }) => (event.type === "user-message" ? [event.text] : []));

// Waits until the project's worker `id` matches, then returns it.
async function workerWhen(member: TestUser, project: Project, id: string, matches: (worker: TaskWorker) => boolean) {
  let found: TaskWorker | undefined;
  await eventually(async () => {
    found = TaskWorker.array()
      .parse(await (await member.api("GET", `/projects/${project.id}/workers`)).json())
      .find((worker) => worker.id === id);
    return found !== undefined && matches(found);
  });
  if (!found) throw new Error("unreachable");
  return found;
}

test("a chief's request ends in a verified pull request: request, follow-up, an engineer's draft PR, a verifier's PASS at its head, done, and the verdict on the chief's card", async () => {
  const control = await gitControl();
  const { owner, github, copilot, workspace } = control;
  // A repo with no project file: the app's settings configure the project.
  github.createRepo("octo-org/shop", { "README.md": "# Shop\nTeh shop.\n" });
  const project = Project.parse(await (await owner.api("POST", `/workspaces/${workspace.id}/projects`, { repo: "octo-org/shop" })).json());
  const settings = "commands:\n  setup: test -f README.md\n  dev: bun run dev\n  devUrl: http://localhost:3000\nworkers:\n  max: 1\n";
  expect((await owner.api("PUT", `/projects/${project.id}/settings`, { text: settings })).status).toBe(200);
  const chief = await owner.onlineBot("Chief");

  let handoff: Handoff | null = null;
  const status: unknown[] = [];
  let checkedOut = "";
  copilot.script = async function* (prompt, runtime) {
    const clone = copilot.workingDirectories.at(-1) ?? "";
    // The chief.
    if (prompt === "Hand the shop project the README typo fix.") {
      const sent = await runtime.tool("send_to_project", {
        project: project.id,
        title: "Fix the README typo",
        request: "The README says Teh shop.",
        acceptance: "A verified pull request that fixes it",
      });
      handoff = Handoff.parse(JSON.parse(String(sent.result)));
    } else if (prompt === "Tell the project to change only the README.") {
      await runtime.tool("message_project", { handoff: handoff?.id ?? null, message: "Change only README.md." });
    } else if (prompt === "How is the typo fix going?") {
      status.push(JSON.parse(String((await runtime.tool("handoff_status", {})).result)));
    }
    // The coordinator: the handoff, the follow-up, then the owner's own messages.
    else if (prompt.includes("task #1 in the ledger")) await runtime.tool("update_task", { number: 1, status: "in_progress" });
    else if (prompt.startsWith("About task #1, from your chief of staff:")) await runtime.tool("dispatch_worker", { task: 1 });
    else if (prompt === "Verify task #1.") await runtime.tool("dispatch_verifier", { task: 1 });
    else if (prompt === "Mark task #1 done.") await runtime.tool("update_task", { number: 1, status: "done" });
    // The engineer, in the clone its setup made.
    else if (prompt.startsWith("You are an engineer")) {
      await runtime.shell(`cd ${clone} && git checkout -q -b fix-typo && sed -i.bak 's/Teh/The/' README.md && rm README.md.bak && git commit -q -am 'Fix a typo' && git push -q -u origin fix-typo`);
      await runtime.tool("create_pull_request", { repository: "octo-org/shop", head: "fix-typo", base: "main", title: "Fix the README typo" });
      yield sdk.message("e-1", "Fixed the typo in a draft pull request.");
    }
    // The verifier, in the clone its setup checked out at the pinned commit.
    else if (prompt.startsWith("You are the verifier")) {
      checkedOut = (await runtime.shell(`cd ${clone} && git rev-parse HEAD`)).output.trim();
      await runtime.tool("report_verdict", { result: "pass", summary: "The README reads The shop." });
    }
    yield sdk.idle();
  };
  const chiefChat = owner.watchChat(chief.id);
  const tell = async (text: string, turns: number) => {
    await owner.send(chief.id, text);
    await chiefChat.until(doneCount(turns));
  };
  const ask = async (text: string, turns: number) => {
    const chat = owner.watchProjectChat(project.id);
    await owner.api("POST", `/projects/${project.id}/messages`, { text });
    await chat.until(doneCount(turns));
  };

  // 1. The chief hands the work over, then follows up: one task, both in the owner's chat with the coordinator.
  await tell("Hand the shop project the README typo fix.", 1);
  await tell("Tell the project to change only the README.", 2);
  const projectChat = await owner.watchProjectChat(project.id).until(doneCount(2));
  const tasks = Task.array().parse(await (await owner.api("GET", `/projects/${project.id}/tasks`)).json());
  expect(tasks.map(({ number, requestedBy }) => [number, requestedBy])).toEqual([[1, "octo-user"]]);
  const sent = sentToCoordinator(projectChat);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe("About task #1, from your chief of staff:\n\nChange only README.md.");

  // 2. The engineer sets up first, then its push and its pull request wait for the owner, and it ends in a draft PR.
  const [engineerId = ""] = await workerIds(owner, project);
  const approve = async (kind: string) => {
    const [pending] = (await workerWhen(owner, project, engineerId, ({ pendingApprovals }) => pendingApprovals[0]?.kind === kind)).pendingApprovals;
    await owner.api("POST", `/projects/${project.id}/workers/${engineerId}/approvals/${pending?.approvalId}`, { approved: true });
  };
  await approve("push");
  await approve("pull-request");
  const engineer = await workerWhen(owner, project, engineerId, ({ state }) => state === "finished");
  const pullRequest = `${github.url}/octo-org/shop/pull/1`;
  expect(engineer).toMatchObject({ kind: "engineer", result: "Fixed the typo in a draft pull request.", pullRequest });
  expect(engineer.setup.map(({ step, command, exitCode }) => [step, command, exitCode])).toEqual([
    ["clone", "git clone https://github.com/octo-org/shop.git shop", 0],
    ["setup", "test -f README.md", 0],
  ]);
  expect(copilot.sends.find(({ sessionId }) => sessionId === engineer.id)?.prompt).toContain("Follow-up from octo-user's chief of staff: Change only README.md.");
  expect(github.pullRequests).toMatchObject([{ repository: "octo-org/shop", head: "fix-typo", base: "main", draft: true, by: "app" }]);
  const head = github.git("octo-org/shop", "rev-parse", "fix-typo");

  // 3. A verifier on a computer of its own checks the pull request at the head control pinned, and passes it.
  await ask("Verify task #1.", 3);
  const verifierId = (await workerIds(owner, project)).find((id) => id !== engineer.id) ?? "";
  const verifier = await workerWhen(owner, project, verifierId, ({ state }) => state === "finished");
  expect(verifier).toMatchObject({ kind: "verifier", state: "finished", verdict: "pass", sha: head, pullRequest });
  expect(checkedOut).toBe(head);

  // 4. The coordinator marks the task done: it has a PASS for its pull request's head.
  await ask("Mark task #1 done.", 4);
  await eventually(() => cards(chiefChat.events).some(({ stage }) => stage === "done"));

  // 5. The chief's card followed the task in place, and says the same after control restarts.
  const passed = { result: "pass", sha: head, stale: false, summary: "The README reads The shop." };
  expect(cards(chiefChat.events).map(({ stage, pullRequests, verification }) => [stage, pullRequests, verification])).toEqual([
    ["accepted", [], null],
    ["working", [], null],
    ["pr_opened", [pullRequest], null],
    ["verified", [pullRequest], passed],
    ["done", [pullRequest], passed],
  ]);
  control.restart();
  await owner.watchBots().until((bots) => bots.some(({ id, status }) => id === chief.id && status === "online"));
  expect(cards(await owner.watchChat(chief.id).settled())).toEqual(cards(chiefChat.events));
  await owner.send(chief.id, "How is the typo fix going?");
  await owner.watchChat(chief.id).until(doneCount(3));
  expect(Handoff.array().parse(status[0])).toMatchObject([
    {
      taskNumber: 1,
      status: "done",
      links: [{ kind: "pull-request", url: pullRequest }],
      workers: [
        { id: engineer.id, kind: "engineer", state: "finished", pullRequest },
        { id: verifier.id, kind: "verifier", state: "finished" },
      ],
      verification: passed,
    },
  ]);
});

// The ids of the project's workers, once it has any, oldest first.
async function workerIds(member: TestUser, project: Project) {
  let ids: string[] = [];
  await eventually(async () => {
    ids = TaskWorker.array()
      .parse(await (await member.api("GET", `/projects/${project.id}/workers`)).json())
      .map(({ id }) => id);
    return ids.length > 0;
  });
  return ids;
}
