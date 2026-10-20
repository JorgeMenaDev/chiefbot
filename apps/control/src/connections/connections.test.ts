import { afterEach, expect, test } from "bun:test";
import { ApiError, Connection, ConnectionCall, type ChatEvent } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { fakeCopilot, sdk } from "@chiefbot/worker/fake-copilot";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    ["dynatrace", false],
    ["gcloud", false],
    ["harness", true],
    ["jira", false],
    ["looker", false],
  ]);
  expect(rows.find(({ name }) => name === "harness")?.fields.token).toMatchObject({ label: expect.any(String), secret: true });
  expect(JSON.stringify(rows)).not.toContain(harness.token);
  expect(connectionSecrets().map(([, value]) => JSON.parse(value))).toEqual([{ token: harness.token }]);
  // Connections are a person's own.
  const other = await signIn(friend);
  expect((await list(other.api)).map(({ on }) => on)).toEqual([false, false, false, false, false]);

  expect((await api("DELETE", "/connections/harness")).status).toBe(204);
  expect((await api("DELETE", "/connections/harness")).status).toBe(204);
  expect((await list()).map(({ on }) => on)).toEqual([false, false, false, false, false]);
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

test("a turn ends and cleans up at once whatever the agent left in the calls log; a million runs log 500", async () => {
  const { api, computers, root, onlineBot, send, watchChat } = await setup();
  await api("PUT", "/connections/harness", { fields: harness });
  const bot = await onlineBot("Ada");
  const chat = watchChat(bot.id);
  const logs = [() => writeFileSync(join(root, "calls"), "harness\x000\0".repeat(1_000_000)), () => (rmSync(join(root, "calls")), Bun.spawnSync(["mkfifo", join(root, "calls")]))];
  computers.copilot.script = async function* () {
    logs.shift()?.();
    yield sdk.idle();
  };

  const first = await send(bot.id, "a million runs");
  await chat.until(doneCount(1));
  expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  await send(bot.id, "a FIFO");
  await chat.until(doneCount(2));
  expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);

  const calls = ConnectionCall.array().parse(await (await api("GET", `/bots/${bot.id}/connection-calls`)).json());
  expect([calls.length, new Set(calls.map(({ run }) => run))]).toEqual([500, new Set([first])]);
});

test("a sub-agent's error does not end the turn's approvals", async () => {
  const { api, computers, onlineBot, send, watchChat } = await setup();
  await api("PUT", "/connections/harness", { fields: harness });
  const bot = await onlineBot("Ada");
  const results: boolean[] = [];
  computers.copilot.script = async function* (_prompt, runtime) {
    const pending = runtime.shell("harness execute pipeline deploy");
    yield { ...sdk.error("a sub-agent failed"), agentId: "sub-agent" };
    results.push((await pending).approved);
    yield sdk.idle();
  };
  const chat = watchChat(bot.id);
  await send(bot.id, "deploy");
  const [request] = (await chat.until((events) => requestsIn(events).length === 1)).flatMap((e) => (e.event.type === "approval-request" ? [e.event] : []));
  await Bun.sleep(100);
  await api("POST", `/bots/${bot.id}/approvals/${request?.approvalId}`, { approved: true });
  await chat.until(doneCount(1));

  expect(results).toEqual([true]);
});

test("control logs a turn's calls only while that turn is unfinished: never for an ended or another turn", async () => {
  const { api, url, botToken, computers, onlineBot, send, watchChat } = await setup();
  await api("PUT", "/connections/harness", { fields: harness });
  const bot = await onlineBot("Ada");
  computers.copilot.script = async function* (_prompt, runtime) {
    await runtime.shell("harness list pipeline");
    yield sdk.idle();
  };
  const ended = await send(bot.id, "list");
  await watchChat(bot.id).until(doneCount(1));

  // A forged report on the bot's own worker socket, for its ended turn and for one that never was.
  const socket = new WebSocket(`${url.replace("http", "ws")}/worker/${bot.id}`, { headers: { authorization: `Bearer ${botToken(bot.id)}` } });
  await new Promise((resolve) => (socket.onopen = resolve));
  for (const turnId of [ended, "turn_forged"]) socket.send(JSON.stringify({ type: "connection-calls", turnId, calls: [{ connection: "harness", command: "harness delete" }] }));
  await Bun.sleep(200);
  socket.close();

  const calls = ConnectionCall.array().parse(await (await api("GET", `/bots/${bot.id}/connection-calls`)).json());
  expect(calls.map(({ command, run }) => [command, run])).toEqual([["harness list", ended]]);
});

test("Stop mid-turn ends the turn: its approval expires, the agent is refused, and its connections are gone", async () => {
  const { api, computers, root, onlineBot, send, watchChat } = await setup();
  await api("PUT", "/connections/harness", { fields: harness });
  const bot = await onlineBot("Ada");
  const results: boolean[] = [];
  computers.copilot.script = async function* (_prompt, runtime) {
    results.push((await runtime.shell("harness execute pipeline deploy")).approved);
    yield sdk.idle();
  };
  const chat = watchChat(bot.id);
  await send(bot.id, "deploy");
  const [request] = (await chat.until((events) => requestsIn(events).length === 1)).flatMap((e) => (e.event.type === "approval-request" ? [e.event] : []));
  expect(readdirSync(root).sort()).toEqual(["bin", "calls", "connections", "skills"]);

  expect((await api("POST", `/bots/${bot.id}/stop`)).status).toBe(200);
  await chat.until(doneCount(1));

  expect(results).toEqual([false]);
  expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  expect((await api("POST", `/bots/${bot.id}/approvals/${request?.approvalId}`, { approved: true })).status).toBe(409);
});

const requestsIn = (events: ChatEvent[]) => events.filter((e) => e.event.type === "approval-request");
