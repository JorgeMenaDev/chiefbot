import { afterEach, expect, test } from "bun:test";
import { ApiError, ApprovalId, BrokeredGitHubToken, type ChatEvent } from "@chiefbot/contracts";
import { fakeCopilot, sdk, type FakeRuntime } from "@chiefbot/worker/fake-copilot";
import { gitProxyConfig } from "@chiefbot/worker/git-proxy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atCleanUp, cleanUp, startTestControl, type TestUser } from "./testControl.ts";

// Repo work end to end: control, a fake GitHub with private repos and the
// deployer's GitHub App, and a bot whose fake Copilot runs real git in a temp
// workspace. As in the bot computer, git reaches GitHub only through control's
// git proxy, with the bot's credential from the worker's credential helper.

afterEach(cleanUp);

const helper = join(import.meta.dir, "../../worker/src/gitCredential.ts");

async function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "chiefbot-workspace-"));
  atCleanUp(() => rmSync(workspace, { recursive: true, force: true }));
  // Short: a unix socket path must fit in about 100 bytes.
  const socket = `/tmp/chiefbot-t12-${crypto.randomUUID().slice(0, 8)}.sock`;
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
  const copilot = fakeCopilot({ shell: { cwd: workspace, env } });
  const control = await startTestControl({ copilot, gitSocket: socket });
  // What the worker gives the agent's shell (index.ts), pointed at the fake GitHub.
  Object.assign(env, gitProxyConfig({ controlUrl: control.url, helper: `"${process.execPath}" ${helper}`, githubUrl: control.github.url }));
  control.github.createRepo("octo/demo", { "README.md": "# Demo\nTeh demo.\n" });
  const bot = await control.user.onlineBot("Ada");
  return { ...control, ...control.user, botId: bot.id, env, workspace };
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

test("the bot clones through control, and its push waits in control until the user approves it", async () => {
  const { github, copilot, api, watchChat, botId } = await setup();
  const results: ShellResult[] = [];
  copilot.script = async function* (_prompt, runtime) {
    await fixTypo(runtime, github.url, results);
    yield sdk.idle();
  };
  const chat = watchChat(botId);

  await api("POST", `/bots/${botId}/messages`, { text: "Fix the typo in octo/demo" });
  const approvalId = await nthApproval(chat);

  // Clone, branch and commit ran without asking; the push waits in control.
  expect(results.map((r) => r.exitCode)).toEqual([0, 0, 0]);
  expect(chat.events.at(-1)?.event).toEqual({
    type: "approval-request",
    approvalId,
    kind: "push",
    detail: "git push to octo/demo: fix-typo",
  });
  expect(github.pushes).toEqual([]);

  const answer = await api("POST", `/bots/${botId}/approvals/${approvalId}`, { approved: true });
  await chat.until(done);

  expect(answer.status).toBe(204);
  expect(results.at(-1)).toMatchObject({ approved: true, exitCode: 0 });
  expect(github.git("octo/demo", "show", "fix-typo:README.md")).toBe("# Demo\nThe demo.");
  // Control pushed with the GitHub App's installation token, not the user's token.
  expect(github.pushes).toEqual([{ repository: "octo/demo", by: "app" }]);
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

  expect(results.at(-1)?.exitCode).not.toBe(0);
  expect(results.at(-1)?.output).toContain("The user declined this push.");
  expect(github.git("octo/demo", "branch", "--list", "fix-typo")).toBe("");
  expect([again.status, ApiError.parse(await again.json())]).toEqual([409, { error: "not_pending" }]);
});

test("from the agent's shell, git finds no GitHub token: not from the credential helper, not from the worker", async () => {
  const { github, copilot, watchChat, send, botId } = await setup();
  const results: ShellResult[] = [];
  copilot.script = async function* (_prompt, runtime) {
    await runtime.shell(`git clone -q ${github.url}/octo/demo.git demo`);
    await runtime.shell("cd demo && git commit -q --allow-empty -m 'Sneaky'");
    const githubHost = new URL(github.url).host;
    // Ask git's credential helpers for github.com's password.
    results.push(await runtime.shell(`printf 'protocol=http\\nhost=${githubHost}\\n\\n' | git credential fill`));
    // Push straight to GitHub, past the proxy.
    results.push(await runtime.shell(`cd demo && GIT_CONFIG_COUNT=0 git push -q ${github.url}/octo/demo.git HEAD:sneaky`));
    // Ask the worker's socket, as the credential helper does.
    results.push(await runtime.shell(`printf '\\n' | ${process.execPath} ${helper} get`));
    yield sdk.idle();
  };
  const chat = watchChat(botId);
  await send(botId, "Push without asking");
  await chat.until(done);

  const [credentialFill, directPush, socketHelper] = results;
  expect(credentialFill?.exitCode).not.toBe(0);
  expect(directPush?.exitCode).not.toBe(0);
  // The worker hands out only the bot's credential for control's proxy.
  expect(socketHelper?.output).toMatch(/^username=chiefbot\npassword=.+\n$/);
  for (const result of results) expect(result.output).not.toMatch(/gh[ousr]_fake_/);
  expect(approvalIds(chat.events)).toEqual([]);
  expect(github.pushes).toEqual([]);
});

// What an agent that stole a GitHub token could do with it, straight to GitHub
// and past control: push a commit to octo/demo (git's exit code) and open a
// pull request there (GitHub's status).
async function misuse(githubUrl: string, token: string) {
  const dir = mkdtempSync(join(tmpdir(), "chiefbot-stolen-"));
  atCleanUp(() => rmSync(dir, { recursive: true, force: true }));
  const remote = new URL(`${githubUrl}/octo/demo.git`);
  remote.username = "x-access-token";
  remote.password = token;
  const env = { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", REMOTE: remote.href };
  const script = 'git init -q && git -c user.name=x -c user.email=x@example.com commit -q --allow-empty -m x && git push -q "$REMOTE" HEAD:refs/heads/stolen';
  // Async: the fake GitHub answers git in this same process.
  const push = await Bun.spawn(["sh", "-c", script], { cwd: dir, env, stderr: "ignore" }).exited;
  const pr = await fetch(`${githubUrl}/repos/octo/demo/pulls`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ head: "main", base: "main", title: "Stolen" }),
  });
  return { pushed: push === 0, pullRequestStatus: pr.status };
}

test("the GitHub token a bot computer gets can neither push nor open pull requests, even where its owner may write", async () => {
  const { github, url, botId, botToken } = await setup();
  const brokered = await fetch(`${url}/worker/${botId}/github-token`, { headers: { authorization: `Bearer ${botToken(botId)}` } });
  const { accessToken } = BrokeredGitHubToken.parse(await brokered.json());

  // A user token of the repo app (the v0.1 sign-in) could do both on the same repo.
  const repoAppToken = github.issueTokens(undefined, github.app.clientId).accessToken;

  expect(await misuse(github.url, accessToken)).toEqual({ pushed: false, pullRequestStatus: 404 });
  expect(await misuse(github.url, repoAppToken)).toEqual({ pushed: true, pullRequestStatus: 201 });
  expect(github.pushes).toEqual([{ repository: "octo/demo", by: "octo-user" }]);
});

test("a push outside a turn fails, even with the bot's credential: nobody can approve it", async () => {
  const { github, env, workspace } = await setup();
  // Async: control answers git in this same process.
  const run = async (command: string) => {
    const proc = Bun.spawn(["sh", "-c", command], { cwd: workspace, env, stderr: "pipe" });
    return { exitCode: await proc.exited, stderr: await new Response(proc.stderr).text() };
  };
  await run(`git clone -q ${github.url}/octo/demo.git demo && cd demo && git commit -q --allow-empty -m x`);

  const push = await run("cd demo && git push -q origin HEAD:early");

  expect(push.exitCode).not.toBe(0);
  expect(push.stderr).toContain("No turn is running, so nobody can approve this push.");
  expect(github.pushes).toEqual([]);
});

test("the bot may clone only what its owner can see, and push only where the owner may write and the app is installed", async () => {
  const { github, copilot, send, watchChat, botId } = await setup();
  github.createRepo("someone/secret", { "README.md": "x\n" }, { access: { someone: "write" } });
  github.createRepo("octo/read-only", { "README.md": "x\n" }, { access: { "octo-user": "read" } });
  github.createRepo("octo/no-app", { "README.md": "x\n" }, { installed: false });
  const results: ShellResult[] = [];
  copilot.script = async function* (_prompt, runtime) {
    results.push(await runtime.shell(`git clone -q ${github.url}/someone/secret.git secret`));
    results.push(await runtime.shell(`git clone -q ${github.url}/octo/read-only.git read-only`));
    results.push(await runtime.shell("cd read-only && git commit -q --allow-empty -m x && git push -q origin HEAD:main"));
    results.push(await runtime.shell(`git clone -q ${github.url}/octo/no-app.git no-app`));
    yield sdk.idle();
  };
  const chat = watchChat(botId);
  await send(botId, "Try them all");
  await chat.until(done);

  expect(results.map((r) => r.exitCode === 0)).toEqual([false, true, false, false]);
  expect(results[0]?.output).toContain("someone/secret was not found, or your GitHub account cannot see it.");
  expect(results[2]?.output).toContain("Your GitHub account cannot push to octo/read-only.");
  expect(results[3]?.output).toContain("Install your Chiefbot GitHub App on octo/no-app");
  expect(approvalIds(chat.events)).toEqual([]);
  expect(github.pushes).toEqual([]);
});

test("the git proxy refuses a path that is not a repo name, so control's tokens never reach other GitHub paths", async () => {
  const { url, botId, botToken } = await setup();
  const auth = { authorization: `Basic ${btoa(`chiefbot:${botToken(botId)}`)}` };

  const res = await fetch(`${url}/git/octo/..git/info/refs?service=git-upload-pack`, { headers: auth });

  expect([res.status, await res.text()]).toEqual([404, "octo/. is not a GitHub repository name.\n"]);
});

test("control opens the bot's pull request only after the user approves it", async () => {
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
    { repository: "octo/demo", number: 1, head: "fix-typo", base: "main", title: "Fix a typo", body: "Teh → The", by: "app" },
  ]);
  expect(pr).toEqual({ approved: true, result: `Opened pull request #1: ${github.url}/octo/demo/pull/1` });
});

test("a declined pull request is never opened, and the bot is told why", async () => {
  const { github, copilot, api, watchChat, botId } = await setup();
  let error: unknown = null;
  copilot.script = async function* (_prompt, runtime) {
    await runtime
      .tool("create_pull_request", { repository: "octo/demo", head: "main", base: "main", title: "Nothing" })
      .catch((caught: unknown) => (error = caught));
    yield sdk.idle();
  };
  const chat = watchChat(botId);
  await api("POST", `/bots/${botId}/messages`, { text: "Open a PR" });
  await api("POST", `/bots/${botId}/approvals/${await nthApproval(chat)}`, { approved: false });
  await chat.until(done);

  expect(github.pullRequests).toEqual([]);
  expect(String(error)).toContain("The user declined this pull request.");
});

test("a push waiting for an answer survives a desktop restart: the card comes back pending and still works", async () => {
  const { github, copilot, api, watchChat, botId } = await setup();
  copilot.script = async function* (_prompt, runtime) {
    await fixTypo(runtime, github.url, []);
    yield sdk.idle();
  };
  await api("POST", `/bots/${botId}/messages`, { text: "Fix the typo" });
  const approvalId = await nthApproval(watchChat(botId));

  // A new chat connection, as after the desktop app restarts.
  const chat = watchChat(botId);
  expect((await chat.settled()).at(-1)?.event).toMatchObject({ type: "approval-request", approvalId });
  await api("POST", `/bots/${botId}/approvals/${approvalId}`, { approved: true });
  await chat.until(done);

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

test("after the owner disconnects GitHub, git in the bot computer gets nothing through control and says to sign in again", async () => {
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
