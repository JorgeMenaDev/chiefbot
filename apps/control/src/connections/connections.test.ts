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

const harness = { account: "acct-123", token: "pat.secret-token" };

test("a person turns a connection on with their own fields; its secrets stay in control and never come back", async () => {
  const { api, signIn, connectionSecrets } = await setup();
  const list = async (as = api) => Connection.array().parse(await (await as("GET", "/connections")).json());

  const missing = await api("PUT", "/connections/harness", { fields: { account: "acct-123" } });
  const unknown = await api("PUT", "/connections/harness", { fields: { ...harness, org: "default" } });
  const nowhere = await api("PUT", "/connections/gitlab", { fields: harness });
  const saved = await api("PUT", "/connections/harness", { fields: harness });

  expect([missing.status, ApiError.parse(await missing.json())]).toEqual([400, { error: "invalid_connection", message: "token is missing" }]);
  expect([unknown.status, ApiError.parse(await unknown.json())]).toEqual([400, { error: "invalid_connection", message: "harness has no field org" }]);
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

test("a command of the CLI that may write waits for the owner; reads run; every command that runs is logged", async () => {
  const { api, computers, onlineBot, send, watchChat } = await setup();
  await api("PUT", "/connections/harness", { fields: harness });
  const bot = await onlineBot("Ada");
  const ran: string[] = [];
  computers.copilot.script = async function* (_prompt, runtime) {
    for (const command of ["harness list pipeline --org default", "harness execute pipeline deploy", "harness delete pipeline deploy"]) {
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
  await chat.until(doneCount(1));

  expect([first?.kind, first?.detail]).toEqual(["connector", "Harness: harness execute pipeline deploy"]);
  expect(second?.detail).toBe("Harness: harness delete pipeline deploy");
  expect(ran).toEqual(["harness list pipeline --org default", "harness execute pipeline deploy"]);
  const calls = ConnectionCall.array().parse(await (await api("GET", `/bots/${bot.id}/connection-calls`)).json());
  expect(calls.map(({ connection, command, run }) => [connection, command, run])).toEqual([
    ["harness", "harness list pipeline", turnId],
    ["harness", "harness execute pipeline deploy", turnId],
  ]);
});

const requestsIn = (events: ChatEvent[]) => events.filter((e) => e.event.type === "approval-request");
