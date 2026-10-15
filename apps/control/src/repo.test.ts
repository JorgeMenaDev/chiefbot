import { afterEach, expect, test } from "bun:test";
import { ApiError, ApprovalId, Bot, ChatEvent, ClientEvent, SignInResponse, type BotId } from "@chiefbot/contracts";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { fakeCopilot, sdk, type FakeRuntime } from "@chiefbot/worker/fake-copilot";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeComputers } from "./computers/fakeComputers.ts";
import { startControl } from "./control.ts";

// Repo work end to end: control, a fake GitHub with a private repo, and a bot
// whose fake Copilot runs real git in a temp workspace. Git gets the owner's
// token only through the worker's credential helper, as in the bot computer.

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

const helper = join(import.meta.dir, "../../worker/src/gitCredential.ts");
const prePush = join(import.meta.dir, "../../worker/src/prePush.ts");

async function setup({ dbPath = ":memory:" }: { dbPath?: string } = {}) {
  const github = startFakeGitHub();
  github.createRepo("octo/demo", { "README.md": "# Demo\nTeh demo.\n" });
  const workspace = mkdtempSync(join(tmpdir(), "chiefbot-workspace-"));
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
  const copilot = fakeCopilot({ shell: { cwd: workspace, env } });
  const computers = fakeComputers({ copilot, gitSocket: socket });
  const control = startControl({ port: 0, dbPath, githubApiUrl: github.url, computers: computers.provider });
  stops.push(github.stop, () => rmSync(workspace, { recursive: true, force: true }), computers.stopAll, control.stop);

  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({
      accessToken,
      accessTokenExpiresAt: Date.now() + 8 * 3600_000,
      refreshToken,
      refreshTokenExpiresAt: Date.now() + 180 * 86400_000,
    }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  const auth = { authorization: `Bearer ${sessionToken}` };
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${control.url}${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  const bot = Bot.parse(await (await api("POST", "/bots", { name: "Ada" })).json());
  await new Promise<void>((resolve) => {
    const socket = new WebSocket(`${control.url.replace("http", "ws")}/events`, { headers: auth });
    socket.onmessage = (event) => {
      const message = ClientEvent.parse(JSON.parse(String(event.data)));
      if (message.type !== "bots" || !message.bots.some((b) => b.status === "online")) return;
      socket.close();
      resolve();
    };
  });
  return { github, copilot, computers, control, auth, api, botId: bot.id };
}

// Every ChatEvent of the bot's chat socket; until() resolves once they match.
function watchChat(controlUrl: string, headers: Record<string, string>, botId: BotId) {
  const socket = new WebSocket(`${controlUrl.replace("http", "ws")}/bots/${botId}/chat`, { headers });
  stops.push(() => socket.close());
  const events: ChatEvent[] = [];
  let wake = () => {};
  socket.onmessage = (message) => {
    events.push(ChatEvent.parse(JSON.parse(String(message.data))));
    wake();
  };
  return {
    events,
    until: (matches: (events: ChatEvent[]) => boolean) =>
      new Promise<ChatEvent[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`chat never matched: ${JSON.stringify(events.map((e) => e.event))}`)), 5000);
        wake = () => {
          if (!matches(events)) return;
          clearTimeout(timer);
          resolve(events);
        };
        wake();
      }),
  };
}

const approvalIds = (events: ChatEvent[]) =>
  events.flatMap(({ event }) => (event.type === "approval-request" ? [event.approvalId] : []));
// Waits for the chat's nth approval-request (0 for the first) and returns its id.
const nthApproval = async (chat: ReturnType<typeof watchChat>, n = 0) =>
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
  const { github, copilot, control, auth, api, botId } = await setup();
  const results: ShellResult[] = [];
  copilot.script = async function* (_prompt, runtime) {
    await fixTypo(runtime, github.url, results);
    yield sdk.idle();
  };
  const chat = watchChat(control.url, auth, botId);

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
  const { github, copilot, control, auth, api, botId } = await setup();
  const results: ShellResult[] = [];
  copilot.script = async function* (_prompt, runtime) {
    await fixTypo(runtime, github.url, results);
    yield sdk.idle();
  };
  const chat = watchChat(control.url, auth, botId);
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
  const { github, copilot, control, auth, api, botId } = await setup();
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
  const chat = watchChat(control.url, auth, botId);
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
  const { github, copilot, control, auth, api, botId } = await setup();
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
  const chat = watchChat(control.url, auth, botId);
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
  const dbPath = join(mkdtempSync(join(tmpdir(), "chiefbot-control-")), "control.sqlite");
  const { github, copilot, computers, control, auth, botId } = await setup({ dbPath });
  const results: ShellResult[] = [];
  copilot.script = async function* (_prompt, runtime) {
    await fixTypo(runtime, github.url, results);
    yield sdk.idle();
  };
  await fetch(`${control.url}/bots/${botId}/messages`, { method: "POST", headers: auth, body: '{"text":"Fix the typo"}' });
  const approvalId = await nthApproval(watchChat(control.url, auth, botId));

  // The desktop quits, control restarts, and the user comes back later.
  control.stop();
  const restarted = startControl({ port: Number(new URL(control.url).port), dbPath, githubApiUrl: github.url, computers: computers.provider });
  stops.push(restarted.stop);
  const answer = await fetch(`${restarted.url}/bots/${botId}/approvals/${approvalId}`, {
    method: "POST",
    headers: auth,
    body: '{"approved":true}',
  });
  const chat = watchChat(restarted.url, auth, botId);
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
  const { github, copilot, computers, control, auth, api, botId } = await setup();
  copilot.script = async function* (_prompt, runtime) {
    await fixTypo(runtime, github.url, []);
    yield sdk.idle();
  };
  await api("POST", `/bots/${botId}/messages`, { text: "Fix the typo" });
  const chat = watchChat(control.url, auth, botId);
  const approvalId = await nthApproval(chat);

  await computers.provider.stop(botId);
  await computers.provider.start(botId);
  await chat.until(done);
  const late = await api("POST", `/bots/${botId}/approvals/${approvalId}`, { approved: true });

  expect(late.status).toBe(409);
  expect(github.git("octo/demo", "branch", "--list", "fix-typo")).toBe("");
});

test("after the owner disconnects GitHub, git in the bot computer gets no token and says to sign in again", async () => {
  const { github, copilot, control, auth, api, botId } = await setup();
  let release = () => {};
  const disconnected = new Promise<void>((resolve) => (release = resolve));
  const results: ShellResult[] = [];
  copilot.script = async function* (_prompt, runtime) {
    await disconnected;
    results.push(await runtime.shell(`git clone -q ${github.url}/octo/demo.git demo`));
    yield sdk.idle();
  };
  const chat = watchChat(control.url, auth, botId);
  await api("POST", `/bots/${botId}/messages`, { text: "Clone octo/demo" });

  await api("DELETE", "/me/github");
  release();
  await chat.until(done);

  expect(results[0]?.exitCode).not.toBe(0);
  expect(results[0]?.output).toContain("Sign in again in the Chiefbot app");
});
