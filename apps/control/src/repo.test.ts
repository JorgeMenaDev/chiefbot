import { afterEach, expect, test } from "bun:test";
import { ApiError, ApprovalId, type ChatEvent } from "@chiefbot/contracts";
import { fakeCopilot, sdk, type FakeRuntime } from "@chiefbot/worker/fake-copilot";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atCleanUp, cleanUp, startTestControl, type TestUser } from "./testControl.ts";

// Repo work end to end: control, a fake GitHub with a private repo, and a bot
// whose fake Copilot runs real git in a temp workspace. Git gets the owner's
// token only through the worker's credential helper, as in the bot computer.

afterEach(cleanUp);

const helper = join(import.meta.dir, "../../worker/src/gitCredential.ts");
const prePush = join(import.meta.dir, "../../worker/src/prePush.ts");

async function setup({ persistent = false } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "chiefbot-workspace-"));
  atCleanUp(() => rmSync(workspace, { recursive: true, force: true }));
  // Short: a unix socket path must fit in about 100 bytes.
  const socket = `/tmp/chiefbot-t06-${crypto.randomUUID().slice(0, 8)}.sock`;
  // The image's hooks directory (infra/computer/hooks), running the hook from source.
  const hooks = join(workspace, ".hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\nexec "${process.execPath}" ${prePush} "$@"\n`);
  chmodSync(join(hooks, "pre-push"), 0o755);
  // What the bot computer's image configures (infra/computer/Dockerfile), minus the
  // github.com scope: the fake remote is on 127.0.0.1.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: workspace,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: `!"${process.execPath}" ${helper}`,
    GIT_CONFIG_KEY_1: "user.name",
    GIT_CONFIG_VALUE_1: "Chiefbot",
    GIT_CONFIG_KEY_2: "user.email",
    GIT_CONFIG_VALUE_2: "chiefbot@example.com",
    GIT_CONFIG_KEY_3: "core.hooksPath",
    GIT_CONFIG_VALUE_3: hooks,
    CHIEFBOT_GIT_SOCKET: socket,
  };
  const control = await startTestControl({ persistent, copilot: fakeCopilot({ shell: { cwd: workspace, env } }), gitSocket: socket });
  control.github.createRepo("octo/demo", { "README.md": "# Demo\nTeh demo.\n" });
  const bot = await control.user.onlineBot("Ada");
  return { ...control, ...control.user, botId: bot.id };
}

const approvalIds = (events: ChatEvent[]) =>
  events.flatMap(({ event }) => (event.type === "approval-request" ? [event.approvalId] : []));
// Waits for the chat's nth approval-request (0 for the first) and returns its id.
const nthApproval = async (chat: ReturnType<TestUser["watchChat"]>, n = 0) =>
  ApprovalId.parse(approvalIds(await chat.until((events) => approvalIds(events).length > n))[n]);
const done = (events: ChatEvent[]) => events.some((e) => e.event.type === "done");

type ShellResult = Awaited<ReturnType<FakeRuntime["shell"]>>;

// The agent's work on "fix the typo": clone, branch, edit, commit, push. Each
// command's result goes into `results` for the test.
async function fixTypo(runtime: FakeRuntime, githubUrl: string, results: ShellResult[]) {
  results.push(await runtime.shell(`git clone -q ${githubUrl}/octo/demo.git demo`));
  results.push(await runtime.shell("cd demo && git checkout -q -b fix-typo && sed -i.bak 's/Teh/The/' README.md && rm README.md.bak"));
  results.push(await runtime.shell("cd demo && git commit -q -am 'Fix a typo'"));
  results.push(await runtime.shell("cd demo && git push -q -u origin fix-typo"));
}

test("the bot clones, commits and pushes with the owner's token, and the push waits for the user's approval", async () => {
  const { github, copilot, api, watchChat, botId } = await setup();
  const results: ShellResult[] = [];
  copilot.script = async function* (_prompt, runtime) {
    await fixTypo(runtime, github.url, results);
    yield sdk.idle();
  };
  const chat = watchChat(botId);

  await api("POST", `/bots/${botId}/messages`, { text: "Fix the typo in octo/demo" });
  const approvalId = await nthApproval(chat);

  // Clone, branch and commit ran; the push waits.
  expect(results.map((r) => [r.approved, r.exitCode])).toEqual([[true, 0], [true, 0], [true, 0]]);
  expect(chat.events.at(-1)?.event).toEqual({
    type: "approval-request",
    approvalId,
    kind: "command",
    detail: "cd demo && git push -q -u origin fix-typo",
  });
  expect(github.git("octo/demo", "branch", "--list", "fix-typo")).toBe("");

  const answer = await api("POST", `/bots/${botId}/approvals/${approvalId}`, { approved: true });
  await chat.until(done);

  expect(answer.status).toBe(204);
  expect(results.at(-1)).toMatchObject({ approved: true, exitCode: 0 });
  expect(github.git("octo/demo", "log", "-1", "--format=%s", "fix-typo")).toBe("Fix a typo");
  expect(github.git("octo/demo", "show", "fix-typo:README.md")).toBe("# Demo\nThe demo.");
  expect(chat.events.map((e) => e.event).filter((e) => e.type === "approval-answer")).toEqual([
    { type: "approval-answer", approvalId, approved: true },
  ]);
});

test("a declined push never reaches GitHub, and an approval is answered once", async () => {
  const { github, copilot, api, watchChat, botId } = await setup();
  const results: ShellResult[] = [];
  copilot.script = async function* (_prompt, runtime) {
    await fixTypo(runtime, github.url, results);
    yield sdk.idle();
  };
  const chat = watchChat(botId);
  await api("POST", `/bots/${botId}/messages`, { text: "Fix the typo in octo/demo" });
  const approvalId = await nthApproval(chat);

  await api("POST", `/bots/${botId}/approvals/${approvalId}`, { approved: false });
  await chat.until(done);
  const again = await api("POST", `/bots/${botId}/approvals/${approvalId}`, { approved: true });

  expect(results.at(-1)).toMatchObject({ approved: false });
  expect(github.git("octo/demo", "branch", "--list", "fix-typo")).toBe("");
  expect([again.status, ApiError.parse(await again.json())]).toEqual([409, { error: "not_pending" }]);
});

test("a push the shell matcher cannot see still asks the user, through git's pre-push hook", async () => {
  const { github, copilot, api, watchChat, botId } = await setup();
  const results: ShellResult[] = [];
  copilot.script = async function* (_prompt, runtime) {
    await runtime.shell(`git clone -q ${github.url}/octo/demo.git demo`);
    await runtime.shell("cd demo && git checkout -q -b fix-typo && git commit -q --allow-empty -m 'Empty'");
    // Asked once by the shell matcher; the hook lets the approved command's push through.
    results.push(await runtime.shell("cd demo && git push -q origin HEAD:early"));
    results.push(await runtime.shell("p=push; cd demo && git $p -q -u origin fix-typo"));
    results.push(await runtime.shell("p=push; cd demo && git $p -q origin fix-typo:other"));
    yield sdk.idle();
  };
  const chat = watchChat(botId);
  await api("POST", `/bots/${botId}/messages`, { text: "Push it" });

  await api("POST", `/bots/${botId}/approvals/${await nthApproval(chat, 0)}`, { approved: true });
  const hookApproval = await nthApproval(chat, 1);
  expect(chat.events.at(-1)?.event).toMatchObject({
    kind: "command",
    detail: `git push to ${github.url}/octo/demo.git: fix-typo`,
  });
  expect(github.git("octo/demo", "branch", "--list", "fix-typo")).toBe("");
  await api("POST", `/bots/${botId}/approvals/${hookApproval}`, { approved: true });
  await api("POST", `/bots/${botId}/approvals/${await nthApproval(chat, 2)}`, { approved: false });
  await chat.until(done);

  expect(approvalIds(chat.events)).toHaveLength(3);
  expect(results.map((r) => r.exitCode === 0)).toEqual([true, true, false]);
  expect(results[2]?.output).toContain("The user declined this push.");
  expect(github.git("octo/demo", "branch", "--list", "--format=%(refname:short)")).toBe("early\nfix-typo\nmain");
});

test("the bot opens a pull request only after the user approves it", async () => {
  const { github, copilot, api, watchChat, botId } = await setup();
  let pr: unknown = null;
  copilot.script = async function* (_prompt, runtime) {
    await fixTypo(runtime, github.url, []);
    pr = await runtime.tool("create_pull_request", {
      repository: "octo/demo",
      head: "fix-typo",
      base: "main",
      title: "Fix a typo",
      body: "Teh → The",
    });
    yield sdk.idle();
  };
  const chat = watchChat(botId);
  await api("POST", `/bots/${botId}/messages`, { text: "Fix the typo and open a PR" });
  await api("POST", `/bots/${botId}/approvals/${await nthApproval(chat, 0)}`, { approved: true });

  const prApproval = await nthApproval(chat, 1);
  expect(chat.events.at(-1)?.event).toMatchObject({ kind: "pull-request", detail: "octo/demo: fix-typo → main\nFix a typo" });
  expect(github.pullRequests).toEqual([]);

  await api("POST", `/bots/${botId}/approvals/${prApproval}`, { approved: true });
  await chat.until(done);

  expect(github.pullRequests).toEqual([
    { repository: "octo/demo", number: 1, head: "fix-typo", base: "main", title: "Fix a typo", body: "Teh → The" },
  ]);
  expect(pr).toEqual({ approved: true, result: `Opened pull request #1: ${github.url}/octo/demo/pull/1` });
});

test("a pending approval survives a desktop and a control restart, and the bot waits until the user answers", async () => {
  const { github, copilot, restart, api, watchChat, botId } = await setup({ persistent: true });
  const results: ShellResult[] = [];
  copilot.script = async function* (_prompt, runtime) {
    await fixTypo(runtime, github.url, results);
    yield sdk.idle();
  };
  await api("POST", `/bots/${botId}/messages`, { text: "Fix the typo" });
  const approvalId = await nthApproval(watchChat(botId));

  // The desktop quits, control restarts, and the user comes back later.
  restart();
  const answer = await api("POST", `/bots/${botId}/approvals/${approvalId}`, { approved: true });
  const chat = watchChat(botId);
  await chat.until(done);

  expect(answer.status).toBe(204);
  expect(chat.events.map((e) => e.event.type).filter((type) => type !== "tool-call")).toEqual([
    "user-message",
    "approval-request",
    "approval-answer",
    "done",
  ]);
  expect(github.git("octo/demo", "log", "-1", "--format=%s", "fix-typo")).toBe("Fix a typo");
});

test("an approval whose turn ended because the bot restarted can no longer be answered", async () => {
  const { github, copilot, computers, api, watchChat, botId } = await setup();
  copilot.script = async function* (_prompt, runtime) {
    await fixTypo(runtime, github.url, []);
    yield sdk.idle();
  };
  await api("POST", `/bots/${botId}/messages`, { text: "Fix the typo" });
  const chat = watchChat(botId);
  const approvalId = await nthApproval(chat);

  await computers.provider.stop(botId);
  await computers.provider.start(botId);
  await chat.until(done);
  const late = await api("POST", `/bots/${botId}/approvals/${approvalId}`, { approved: true });

  expect(late.status).toBe(409);
  expect(github.git("octo/demo", "branch", "--list", "fix-typo")).toBe("");
});

test("after the owner disconnects GitHub, git in the bot computer gets no token and says to sign in again", async () => {
  const { github, copilot, api, watchChat, botId } = await setup();
  let release = () => {};
  const disconnected = new Promise<void>((resolve) => (release = resolve));
  const results: ShellResult[] = [];
  copilot.script = async function* (_prompt, runtime) {
    await disconnected;
    results.push(await runtime.shell(`git clone -q ${github.url}/octo/demo.git demo`));
    yield sdk.idle();
  };
  const chat = watchChat(botId);
  await api("POST", `/bots/${botId}/messages`, { text: "Clone octo/demo" });

  await api("DELETE", "/me/github");
  release();
  await chat.until(done);

  expect(results[0]?.exitCode).not.toBe(0);
  expect(results[0]?.output).toContain("Sign in again in the Chiefbot app");
});
