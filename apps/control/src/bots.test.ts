import { afterEach, expect, test } from "bun:test";
import { Bot, ClientEvent, SignInResponse, type BotId } from "@chiefbot/contracts";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControl } from "./control.ts";
import type { ComputerProvider } from "./computers/computer.ts";
import { fakeComputers } from "./computers/fakeComputers.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

async function setup({ dbPath = ":memory:", provider }: { dbPath?: string; provider?: ComputerProvider } = {}) {
  const github = startFakeGitHub();
  const computers = fakeComputers();
  const control = startControl({ port: 0, dbPath, githubApiUrl: github.url, computers: provider ?? computers.provider });
  stops.push(github.stop, computers.stopAll, control.stop);
  const accessToken = github.issueTokens().accessToken;
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken, accessTokenExpiresAt: 0, refreshToken: "ghr_x", refreshTokenExpiresAt: 0 }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  const auth = { authorization: `Bearer ${sessionToken}` };
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${control.url}${path}`, {
      method,
      headers: { ...auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const createBot = async (name: string) => Bot.parse(await (await api("POST", "/bots", { name })).json());
  return { github, control, computers, accessToken, sessionToken, auth, api, createBot, events: watchBots(control.url, auth) };
}

// The desktop's view: the /events WebSocket's latest bot list.
function watchBots(controlUrl: string, headers: Record<string, string>) {
  const socket = new WebSocket(`${controlUrl.replace("http", "ws")}/events`, { headers });
  stops.push(() => socket.close());
  let latest: Bot[] = [];
  const waiters = new Set<() => void>();
  socket.onmessage = (event) => {
    const message = ClientEvent.parse(JSON.parse(String(event.data)));
    if (message.type !== "bots") return;
    latest = message.bots;
    for (const wake of waiters) wake();
  };
  return {
    // Resolves once the list matches, failing after a second.
    until(matches: (bots: Bot[]) => boolean) {
      return new Promise<Bot[]>((resolve, reject) => {
        const check = () => {
          if (!matches(latest)) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(latest);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`bots never matched; last: ${JSON.stringify(latest)}`));
        }, 1000);
        waiters.add(check);
        check();
      });
    },
  };
}

const statusOf = (botId: BotId) => (bots: Bot[]) => bots.find((bot) => bot.id === botId)?.status;

test("a new bot gets its own computer, and its worker comes online with a bot credential, not the user's tokens", async () => {
  const { computers, accessToken, sessionToken, createBot, events } = await setup();

  const bot = await createBot("Ada");

  expect(bot).toMatchObject({ name: "Ada", status: "starting" });
  await events.until((bots) => statusOf(bot.id)(bots) === "online");
  const env = computers.computers.get(bot.id)?.spec.env ?? {};
  expect(env.CHIEFBOT_BOT_TOKEN).toEqual(expect.any(String));
  expect(JSON.stringify(env)).not.toContain(accessToken);
  expect(JSON.stringify(env)).not.toContain(sessionToken);
});

test("the worker endpoint refuses the user's session and GitHub tokens", async () => {
  const { control, accessToken, sessionToken, createBot } = await setup();
  const bot = await createBot("Ada");

  for (const token of [sessionToken, accessToken, ""]) {
    const res = await fetch(`${control.url}/worker/${bot.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  }
});

test("stop stops the bot's computer and start brings the bot back online", async () => {
  const { api, computers, createBot, events } = await setup();
  const bot = await createBot("Ada");
  await events.until((bots) => statusOf(bot.id)(bots) === "online");

  expect((await api("POST", `/bots/${bot.id}/stop`)).status).toBe(200);
  await events.until((bots) => statusOf(bot.id)(bots) === "stopped");
  expect(await computers.provider.status(bot.id)).toBe("stopped");

  expect((await api("POST", `/bots/${bot.id}/start`)).status).toBe(200);
  await events.until((bots) => statusOf(bot.id)(bots) === "online");
});

test("delete removes the bot and its computer, keeping its data unless asked to delete it", async () => {
  const { api, computers, createBot, events } = await setup();
  const kept = await createBot("Ada");
  const wiped = await createBot("Grace");

  expect((await api("DELETE", `/bots/${kept.id}`)).status).toBe(204);
  expect((await api("DELETE", `/bots/${wiped.id}?deleteData=true`)).status).toBe(204);

  await events.until((bots) => bots.length === 0);
  expect(computers.destroyed).toEqual([
    { botId: kept.id, deleteData: false },
    { botId: wiped.id, deleteData: true },
  ]);
  expect((await api("POST", `/bots/${kept.id}/start`)).status).toBe(404);
});

test("a running bot comes back online after control restarts", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "chiefbot-control-")), "control.sqlite");
  const { github, control, computers, auth, createBot, events } = await setup({ dbPath });
  const bot = await createBot("Ada");
  await events.until((bots) => statusOf(bot.id)(bots) === "online");

  control.stop();
  const port = Number(new URL(control.url).port);
  const restarted = startControl({ port, dbPath, githubApiUrl: github.url, computers: computers.provider });
  stops.push(restarted.stop);

  await watchBots(restarted.url, auth).until((bots) => statusOf(bot.id)(bots) === "online");
});

test("a bot whose computer fails to start is not kept", async () => {
  const broken = fakeComputers();
  const { api } = await setup({
    provider: { ...broken.provider, start: () => Promise.reject(new Error("no such image")) },
  });

  const res = await api("POST", "/bots", { name: "Ada" });

  expect(res.status).toBe(502);
  expect(await (await api("GET", "/bots")).json()).toEqual([]);
  expect(broken.destroyed).toHaveLength(1);
});

test("a worker credential works only for its own bot", async () => {
  const { control, computers, createBot } = await setup();
  const ada = await createBot("Ada");
  const grace = await createBot("Grace");
  const adaToken = computers.computers.get(ada.id)?.spec.env.CHIEFBOT_BOT_TOKEN;

  const asWorker = (botId: BotId) =>
    fetch(`${control.url}/worker/${botId}`, { headers: { authorization: `Bearer ${adaToken}` } });

  expect((await asWorker(grace.id)).status).toBe(403);
  // Its own bot gets past the credential check to the WebSocket upgrade.
  expect((await asWorker(ada.id)).status).toBe(400);
});
