import { afterEach, expect, test } from "bun:test";
import { ApiError, Connection, ConnectionCall, type ChatEvent } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { fakeCopilot, sdk } from "@chiefbot/worker/fake-copilot";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretStore } from "../secrets/secretStore.ts";
import { cleanUp, doneCount, startTestControl } from "../testControl.ts";

afterEach(cleanUp);

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } };

// Control whose bots stage connections under `root`, with a SecretStore the test
// can read, and a fake `harness` CLI on the shell's PATH (after the wrappers, as
// the real runtime has it) that prints what it got.
async function setup() {
  const secrets = new Map<string, string>();
  const store: SecretStore = {
    get: async (name) => secrets.get(name) ?? null,
    put: async (name, value) => void secrets.set(name, value),
    delete: async (name) => void secrets.delete(name),
  };
  const root = mkdtempSync(join(tmpdir(), "chiefbot-turn-"));
  const tools = mkdtempSync(join(tmpdir(), "chiefbot-tools-"));
  writeFileSync(join(tools, "harness"), '#!/bin/sh\necho "harness $* key=$HARNESS_API_KEY account=$HARNESS_ACCOUNT_ID"\n');
  chmodSync(join(tools, "harness"), 0o755);
  const shell = { cwd: tmpdir(), env: { PATH: `${root}/bin:${tools}:${process.env.PATH ?? ""}` } };
  const control = await startTestControl({ secrets: store, connectionsRoot: root, copilot: fakeCopilot({ shell }) });
  const connectionSecrets = () => [...secrets].filter(([name]) => name.startsWith("connection-"));
  return { ...control, ...control.user, root, connectionSecrets };
}

const harness = { account: "acct-123", org: "default", project: "shop", token: "pat.secret-token" };

test("a person turns a connection on with their own fields; its secrets stay in control and never come back", async () => {
  const { api, signIn, connectionSecrets } = await setup();
  const list = async (as = api) => Connection.array().parse(await (await as("GET", "/connections")).json());

  const missing = await api("PUT", "/connections/harness", { fields: { account: "acct-123", org: "default", project: "shop" } });
  const unknown = await api("PUT", "/connections/harness", { fields: { ...harness, region: "eu" } });
  const nowhere = await api("PUT", "/connections/gitlab", { fields: harness });
  const saved = await api("PUT", "/connections/harness", { fields: harness });

  expect([missing.status, ApiError.parse(await missing.json())]).toEqual([400, { error: "invalid_connection", message: "token is missing" }]);
  expect([unknown.status, ApiError.parse(await unknown.json())]).toEqual([400, { error: "invalid_connection", message: "harness has no field region" }]);
  expect(nowhere.status).toBe(404);
  expect(saved.status).toBe(200);
  const rows = await list();
  expect(rows.map(({ name, on }) => [name, on])).toEqual([
    ["harness", true],
    ["jira", false],
  ]);
  expect(rows[0]?.fields.token).toEqual({ label: expect.any(String), secret: true });
  expect(JSON.stringify(rows)).not.toContain(harness.token);
  expect(connectionSecrets().map(([, value]) => JSON.parse(value))).toEqual([{ token: harness.token }]);
  // Connections are a person's own.
  const other = await signIn(friend);
  expect((await list(other.api)).map(({ on }) => on)).toEqual([false, false]);

  expect((await api("DELETE", "/connections/harness")).status).toBe(204);
  expect((await api("DELETE", "/connections/harness")).status).toBe(204);
  expect((await list()).map(({ on }) => on)).toEqual([false, false]);
  expect(connectionSecrets()).toEqual([]);
});

test("the owner's bot gets an enabled connection for the turn only: its skill, its files and its CLI as the owner", async () => {
  const { api, computers, root, onlineBot, send, watchChat, signIn } = await setup();
  await api("PUT", "/connections/harness", { fields: harness });
  const bot = await onlineBot("Ada");
  const seen: Array<{ output: string; skill: string; tokenMode: number }> = [];
  computers.copilot.script = async function* (_prompt, runtime) {
    const { output } = await runtime.shell("harness list pipeline");
    const token = join(root, "connections/harness/token");
    const skill = existsSync(join(root, "skills/harness/SKILL.md")) ? readFileSync(join(root, "skills/harness/SKILL.md"), "utf8") : "";
    seen.push({ output, skill, tokenMode: existsSync(token) ? statSync(token).mode & 0o777 : 0 });
    yield sdk.idle();
  };

  await send(bot.id, "list my pipelines");
  await watchChat(bot.id).until(doneCount(1));

  expect(seen).toEqual([{ output: "harness list pipeline key=pat.secret-token account=acct-123\n", skill: expect.stringContaining("name: harness"), tokenMode: 0o600 }]);
  expect(computers.copilot.skillDirectories.at(-1)).toEqual([join(root, "skills")]);
  // Once the turn is over, nothing of it is left on the computer.
  expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);

  // Turned off, the next turn has no skill and the bare CLI has no credential.
  await api("DELETE", "/connections/harness");
  await send(bot.id, "again");
  await watchChat(bot.id).until(doneCount(2));
  expect(seen.at(-1)).toEqual({ output: "harness list pipeline key= account=\n", skill: "", tokenMode: 0 });
  expect(computers.copilot.skillDirectories.at(-1)).toEqual([]);

  // Another person's connection never reaches this person's bot.
  const other = await signIn(friend);
  await other.api("PUT", "/connections/harness", { fields: harness });
  await send(bot.id, "and again");
  await watchChat(bot.id).until(doneCount(3));
  expect(seen.at(-1)?.output).toBe("harness list pipeline key= account=\n");
});

test("a command of the CLI that may write waits for the owner; reads run; every run of the CLI is logged, as its subcommands", async () => {
  const { api, computers, onlineBot, send, watchChat } = await setup();
  await api("PUT", "/connections/harness", { fields: harness });
  const bot = await onlineBot("Ada");
  const ran: string[] = [];
  computers.copilot.script = async function* (_prompt, runtime) {
    for (const command of [
      "harness get secret production-db",
      "false && harness execute pipeline deploy",
      "harness delete pipeline deploy",
      "env DEBUG=1 harness execute pipeline deploy",
    ]) {
      if ((await runtime.shell(command)).approved) ran.push(command);
    }
    yield sdk.idle();
  };
  const chat = watchChat(bot.id);
  const turnId = await send(bot.id, "deploy");
  const answer = async (n: number, approved: boolean) => {
    const requests = (await chat.until((events) => requestsIn(events).length >= n)).flatMap((e) => (e.event.type === "approval-request" ? [e.event] : []));
    const request = requests[n - 1];
    await api("POST", `/bots/${bot.id}/approvals/${request?.approvalId}`, { approved });
    return request;
  };

  const first = await answer(1, true);
  const second = await answer(2, false);
  const third = await answer(3, true);
  await chat.until(doneCount(1));

  expect([first?.kind, first?.detail]).toEqual(["connector", "Harness: harness execute pipeline deploy"]);
  expect(second?.detail).toBe("Harness: harness delete pipeline deploy");
  expect(third?.detail).toBe("Harness: env DEBUG=1 harness execute pipeline deploy");
  expect(ran).toEqual(["harness get secret production-db", "false && harness execute pipeline deploy", "env DEBUG=1 harness execute pipeline deploy"]);
  // Only what ran: the approved deploy behind `false &&` never did. A read names its subcommands, a write only the CLI.
  const calls = ConnectionCall.array().parse(await (await api("GET", `/bots/${bot.id}/connection-calls`)).json());
  expect(calls.map(({ connection, command, run }) => [connection, command, run])).toEqual([
    ["harness", "harness get", turnId],
    ["harness", "harness", turnId],
  ]);
});

test("an approval still pending when its turn ends is refused, and its command never runs", async () => {
  const { api, computers, onlineBot, send, watchChat } = await setup();
  await api("PUT", "/connections/harness", { fields: harness });
  const bot = await onlineBot("Ada");
  const late = Promise.withResolvers<{ approved: boolean }>();
  computers.copilot.script = async function* (_prompt, runtime) {
    const pending = runtime.shell("harness execute pipeline deploy");
    yield sdk.idle();
    late.resolve(await pending);
  };
  const chat = watchChat(bot.id);
  await send(bot.id, "deploy");
  await chat.until(doneCount(1));

  expect((await late.promise).approved).toBe(false);
  expect(await (await api("GET", `/bots/${bot.id}/connection-calls`)).json()).toEqual([]);
});

// Control's answers to the worker's connection-call reports, faked for one test:
// `answer` gets each report's number (from 1) and gives the response, or throws.
function interceptReports(answer: (n: number, real: () => Promise<Response>) => Promise<Response>) {
  const real = globalThis.fetch;
  let n = 0;
  const intercepted = (input: string | URL | Request, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).endsWith("/connection-calls") && init?.method === "POST"
      ? answer(++n, () => real(input, init))
      : real(input, init);
  globalThis.fetch = Object.assign(intercepted, { preconnect: real.preconnect });
  afterEach(() => void (globalThis.fetch = real));
}

test("reporting never holds up a turn's end: once reports start failing, the turn ends anyway", async () => {
  const { api, computers, root, onlineBot, send, watchChat } = await setup();
  await api("PUT", "/connections/harness", { fields: harness });
  const bot = await onlineBot("Ada");
  interceptReports(async (n, real) => {
    if (n > 3) throw new Error("control is unreachable");
    return real();
  });
  computers.copilot.script = async function* (_prompt, runtime) {
    for (let i = 0; i < 5; i++) await runtime.shell("harness list pipeline");
    yield sdk.idle();
  };

  await send(bot.id, "list");
  await watchChat(bot.id).until(doneCount(1));

  expect(await (await api("GET", `/bots/${bot.id}/connection-calls`)).json()).toHaveLength(3);
  expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
});

test("when a turn ends, its pending approval is refused before its calls are reported", async () => {
  const { api, computers, onlineBot, send, watchChat } = await setup();
  await api("PUT", "/connections/harness", { fields: harness });
  const bot = await onlineBot("Ada");
  let settled: { approved: boolean } | null = null;
  const seenWhileReporting: Array<boolean | null> = [];
  interceptReports(async (_n, real) => {
    await Bun.sleep(100);
    seenWhileReporting.push(settled?.approved ?? null);
    return real();
  });
  const asked = Promise.withResolvers<void>();
  computers.copilot.script = async function* (_prompt, runtime) {
    await runtime.shell("harness list pipeline");
    void runtime.shell("harness execute pipeline deploy").then((result) => (settled = result));
    await asked.promise;
    yield sdk.idle();
  };
  const chat = watchChat(bot.id);

  await send(bot.id, "deploy");
  await chat.until((events) => requestsIn(events).length === 1);
  asked.resolve();
  await chat.until(doneCount(1));

  expect(seenWhileReporting).toEqual([false]);
});

const requestsIn = (events: ChatEvent[]) => events.filter((e) => e.event.type === "approval-request");
