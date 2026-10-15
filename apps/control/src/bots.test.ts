import { afterEach, expect, test } from "bun:test";
import { Bot, ClientEvent, SignInResponse, type BotId } from "@chiefbot/contracts";
import { startFakeGitHub, type FakeGitHubUser } from "@chiefbot/fake-github";
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
  // Signs `as` (default: the fake's user) in to control; returns their session.
  const signIn = async (as?: FakeGitHubUser) => {
    const { accessToken } = github.issueTokens(as);
    const res = await fetch(`${control.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken, accessTokenExpiresAt: 0, refreshToken: "ghr_x", refreshTokenExpiresAt: 0 }),
    });
    return { accessToken, sessionToken: SignInResponse.parse(await res.json()).sessionToken };
  };
  const { accessToken, sessionToken } = await signIn();
  const auth = { authorization: `Bearer ${sessionToken}` };
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${control.url}${path}`, {
      method,
      headers: { ...auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const createBot = async (name: string) => Bot.parse(await (await api("POST", "/bots", { name })).json());
  return {
    github,
    control,
    computers,
    accessToken,
    sessionToken,
    auth,
    api,
    signIn,
    createBot,
    events: watchBots(control.url, auth),
  };
}

// The desktop's view: the /events WebSocket's latest bot list.
function watchBots(controlUrl: string, headers: Record<string, string>) {
  const socket = new WebSocket(`${controlUrl.replace("http", "ws")}/events`, { headers });
  stops.push(() => socket.close());
  let latest: Bot[] = [];
  const waiters = new Set<() => void>();
  socket.onmessage = (event) => {
    latest = ClientEvent.parse(JSON.parse(String(event.data))).bots;
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
  const { control, accessToken, sessionToken } = await setup();

  for (const token of [sessionToken, accessToken, ""]) {
    const res = await fetch(`${control.url}/worker`, { headers: { authorization: `Bearer ${token}` } });
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

// Resolves once check() is true, failing after a second.
async function eventually(check: () => boolean) {
  for (let waited = 0; !check(); waited += 10) {
    if (waited > 1000) throw new Error("condition never became true");
    await Bun.sleep(10);
  }
}

// A viewer on a bot's screen through control, as the desktop's noVNC opens it.
function openScreen(controlUrl: string, botId: BotId, headers: Record<string, string>) {
  const socket = new WebSocket(`${controlUrl.replace("http", "ws")}/bots/${botId}/screen`, { headers });
  socket.binaryType = "arraybuffer";
  stops.push(() => socket.close());
  const received: string[] = [];
  socket.onmessage = (event) => {
    received.push(event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : String(event.data));
  };
  return { socket, received };
}

test("the owner watches the bot's screen through control, with bytes flowing both ways", async () => {
  const { control, computers, auth, createBot, events } = await setup();
  const bot = await createBot("Ada");
  await events.until((bots) => statusOf(bot.id)(bots) === "online");

  const viewer = openScreen(control.url, bot.id, auth);

  // The fake screen greets like a VNC server; the viewer's reply reaches it.
  await eventually(() => viewer.received.join("") === "RFB 003.008\n");
  viewer.socket.send(new TextEncoder().encode("RFB 003.008\n"));
  await eventually(() => computers.screenInput.get(bot.id)?.join("") === "RFB 003.008\n");
});

test("another user's bot screen and take-over are refused", async () => {
  const { control, signIn, createBot, api } = await setup();
  const bot = await createBot("Ada");
  const mallory = await signIn({ id: 666, login: "mallory", copilot: null });
  const malloryAuth = { authorization: `Bearer ${mallory.sessionToken}` };

  const screen = await fetch(`${control.url}/bots/${bot.id}/screen`, { headers: malloryAuth });
  const takeOver = await fetch(`${control.url}/bots/${bot.id}/take-over`, { method: "POST", headers: malloryAuth });
  const anonymous = await fetch(`${control.url}/bots/${bot.id}/screen`);

  expect(screen.status).toBe(404);
  expect(takeOver.status).toBe(404);
  expect(anonymous.status).toBe(401);
  expect(Bot.parse(await (await api("POST", `/bots/${bot.id}/hand-back`)).json()).screenControl).toBe("agent");
});

test("a stopped bot has no screen to watch", async () => {
  const { control, auth, api, createBot } = await setup();
  const bot = await createBot("Ada");
  await api("POST", `/bots/${bot.id}/stop`);

  const res = await fetch(`${control.url}/bots/${bot.id}/screen`, { headers: auth });

  expect(res.status).toBe(409);
});

test("take over gives the human the screen and tells the worker; hand back returns it to the agent", async () => {
  const { api, computers, createBot, events } = await setup();
  const bot = await createBot("Ada");
  expect(bot.screenControl).toBe("agent");
  await events.until((bots) => statusOf(bot.id)(bots) === "online");
  const worker = () => computers.computers.get(bot.id)?.worker;

  const taken = Bot.parse(await (await api("POST", `/bots/${bot.id}/take-over`)).json());
  expect(taken.screenControl).toBe("human");
  await events.until((bots) => bots.find((b) => b.id === bot.id)?.screenControl === "human");
  await eventually(() => worker()?.screenControl() === "human");

  await api("POST", `/bots/${bot.id}/hand-back`);
  await events.until((bots) => bots.find((b) => b.id === bot.id)?.screenControl === "agent");
  await eventually(() => worker()?.screenControl() === "agent");
});
