import { afterEach, expect, test } from "bun:test";
import { Bot, type BotId } from "@chiefbot/contracts";
import type { ComputerProvider } from "./computers/computer.ts";
import { atCleanUp, cleanUp, eventually, startTestControl, type TestControlOptions, type TestUser } from "./testControl.ts";

afterEach(cleanUp);

async function setup(options: TestControlOptions = {}) {
  const control = await startTestControl(options);
  return { ...control, ...control.user, accessToken: control.user.tokens.accessToken, events: control.user.watchBots() };
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
  const { url, accessToken, sessionToken, createBot } = await setup();
  const bot = await createBot("Ada");

  for (const token of [sessionToken, accessToken, ""]) {
    const res = await fetch(`${url}/worker/${bot.id}`, { headers: { authorization: `Bearer ${token}` } });
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
    { id: kept.id, deleteData: false },
    { id: wiped.id, deleteData: true },
  ]);
  expect((await api("POST", `/bots/${kept.id}/start`)).status).toBe(404);
});

test("a running bot comes back online after control restarts", async () => {
  const { restart, watchBots, createBot, events } = await setup({ persistent: true });
  const bot = await createBot("Ada");
  await events.until((bots) => statusOf(bot.id)(bots) === "online");

  restart();

  await watchBots().until((bots) => statusOf(bot.id)(bots) === "online");
});

test("a bot whose computer fails to start is not kept", async () => {
  const { api, computers } = await setup({
    provider: (fake) => ({ ...fake, start: () => Promise.reject(new Error("no such image")) }),
  });

  const res = await api("POST", "/bots", { name: "Ada" });

  expect(res.status).toBe(502);
  expect(Bot.array().parse(await (await api("GET", "/bots")).json())).toEqual([]);
  expect(computers.destroyed).toHaveLength(1);
});

test("a new user's first sign-in brings a first bot online, and signing in again adds none", async () => {
  const { signIn, watchBots } = await setup({ firstBot: "Chief of Staff" });

  const first = await watchBots().until((bots) => bots[0]?.status === "online");
  const again = await signIn();

  expect(first).toMatchObject([{ name: "Chief of Staff" }]);
  expect((await again.bots()).map(({ id }) => id)).toEqual(first.map(({ id }) => id));
});

test("a deleted first bot stays deleted", async () => {
  const { api, signIn, watchBots } = await setup({ firstBot: "Chief of Staff" });
  const [chief] = await watchBots().until((bots) => bots.length === 1);

  await api("DELETE", `/bots/${chief?.id}`);
  const again = await signIn();

  expect(await again.bots()).toEqual([]);
});

test("a first bot whose computer fails to start is tried again at the next sign-in", async () => {
  let starts = 0;
  const { signIn, computers } = await setup({
    firstBot: "Chief of Staff",
    provider: (fake) => ({ ...fake, start: (id) => (++starts === 1 ? Promise.reject(new Error("no such image")) : fake.start(id)) }),
  });
  await eventually(() => computers.destroyed.length === 1);

  const again = await signIn();

  expect(await again.watchBots().until((bots) => bots[0]?.status === "online")).toMatchObject([{ name: "Chief of Staff" }]);
});

// A provider whose computers are made only once the test opens the gate (if
// ever); making them fails if `fail`.
function gatedCreate(fail = false) {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const provider = (fake: ComputerProvider): ComputerProvider => ({
    ...fake,
    create: async (spec) => {
      await opened;
      return fail ? Promise.reject(new Error("quota exceeded")) : fake.create(spec);
    },
  });
  return { provider, open };
}

// The user's one bot, once it is listed.
async function onlyBot(watch: TestUser["watchBots"]) {
  const [bot] = await watch().until((bots) => bots.length === 1);
  if (!bot) throw new Error("no bot");
  return bot;
}

test("Start, Stop and Delete refuse a bot whose computer is still being made", async () => {
  const gate = gatedCreate();
  const { api, watchBots } = await setup({ firstBot: "Chief of Staff", provider: gate.provider });
  const { id } = await onlyBot(watchBots);

  for (const [method, path] of [["POST", "start"], ["POST", "stop"], ["DELETE", ""]] as const) {
    const res = await api(method, `/bots/${id}${path ? `/${path}` : ""}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "bot_starting" });
  }
  gate.open();
  await watchBots().until((bots) => statusOf(id)(bots) === "online");
  expect((await api("DELETE", `/bots/${id}`)).status).toBe(204);
});

test("a first bot whose computer is not made in time is dropped, its late computer destroyed, and the next sign-in tries again", async () => {
  const gate = gatedCreate();
  const { signIn, computers, watchBots } = await setup({ firstBot: "Chief of Staff", provider: gate.provider, launchTimeoutMinutes: 0.002 });
  const { id } = await onlyBot(watchBots);
  await watchBots().until((bots) => bots.length === 0);

  gate.open();
  const again = await signIn();

  await eventually(async () => (await computers.provider.status(id)) === "absent");
  expect(await again.watchBots().until((bots) => bots[0]?.status === "online")).toMatchObject([{ name: "Chief of Staff" }]);
});

test("a computer whose making fails after the deadline is destroyed again, for what it left behind", async () => {
  const gate = gatedCreate(true);
  const { computers, watchBots } = await setup({ firstBot: "Chief of Staff", provider: gate.provider, launchTimeoutMinutes: 0.002 });
  const { id } = await onlyBot(watchBots);
  await watchBots().until((bots) => bots.length === 0);
  await eventually(() => computers.destroyed.length === 1);

  gate.open();

  await eventually(() => computers.destroyed.length === 2);
  expect(computers.destroyed).toEqual([
    { id, deleteData: true },
    { id, deleteData: true },
  ]);
});

test("stopping control mid-launch cancels the deadline: nothing is destroyed and the bot is there after a restart", async () => {
  const gate = gatedCreate();
  const { stopControl, startControl, watchBots, signIn, computers } = await setup({
    persistent: true,
    firstBot: "Chief of Staff",
    provider: gate.provider,
    launchTimeoutMinutes: 0.002,
  });
  await onlyBot(watchBots);

  stopControl();
  await Bun.sleep(300);
  startControl();

  expect(computers.destroyed).toEqual([]);
  expect(await (await signIn()).bots()).toMatchObject([{ name: "Chief of Staff" }]);
});

test("a worker credential works only for its own bot", async () => {
  const { url, botToken, createBot } = await setup();
  const ada = await createBot("Ada");
  const grace = await createBot("Grace");
  const adaToken = botToken(ada.id);

  const asWorker = (botId: BotId) =>
    fetch(`${url}/worker/${botId}`, { headers: { authorization: `Bearer ${adaToken}` } });

  expect((await asWorker(grace.id)).status).toBe(403);
  // Its own bot gets past the credential check to the WebSocket upgrade.
  expect((await asWorker(ada.id)).status).toBe(400);
});

// A viewer on a bot's screen through control, as the desktop's noVNC opens it.
function openScreen(controlUrl: string, botId: BotId, headers: Record<string, string>) {
  const socket = new WebSocket(`${controlUrl.replace("http", "ws")}/bots/${botId}/screen`, { headers });
  socket.binaryType = "arraybuffer";
  atCleanUp(() => socket.close());
  const received: string[] = [];
  socket.onmessage = (event) => {
    received.push(event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : String(event.data));
  };
  return { socket, received };
}

test("the owner watches the bot's screen through control, with bytes flowing both ways", async () => {
  const { url, computers, auth, createBot, events } = await setup();
  const bot = await createBot("Ada");
  await events.until((bots) => statusOf(bot.id)(bots) === "online");

  const viewer = openScreen(url, bot.id, auth);

  // The fake screen greets like a VNC server; the viewer's reply reaches it.
  await eventually(() => viewer.received.join("") === "RFB 003.008\n");
  viewer.socket.send(new TextEncoder().encode("RFB 003.008\n"));
  await eventually(() => computers.screenInput.get(bot.id)?.join("") === "RFB 003.008\n");
});

test("another user's bot screen and take-over are refused", async () => {
  const { url, signIn, createBot, api } = await setup();
  const bot = await createBot("Ada");
  const mallory = await signIn({ id: 666, login: "mallory", copilot: null });
  const malloryAuth = { authorization: `Bearer ${mallory.sessionToken}` };

  const screen = await fetch(`${url}/bots/${bot.id}/screen`, { headers: malloryAuth });
  const takeOver = await fetch(`${url}/bots/${bot.id}/take-over`, { method: "POST", headers: malloryAuth });
  const anonymous = await fetch(`${url}/bots/${bot.id}/screen`);

  expect(screen.status).toBe(404);
  expect(takeOver.status).toBe(404);
  expect(anonymous.status).toBe(401);
  expect(Bot.parse(await (await api("POST", `/bots/${bot.id}/hand-back`)).json()).screenControl).toBe("agent");
});

test("a worker can join only a screen stream control opened for its own bot", async () => {
  const { url, botToken, createBot } = await setup();
  const ada = await createBot("Ada");
  const grace = await createBot("Grace");
  const adaToken = botToken(ada.id);

  const join = (botId: BotId, streamId: string) =>
    fetch(`${url}/worker/${botId}/screen/${streamId}`, { headers: { authorization: `Bearer ${adaToken}` } });

  expect((await join(grace.id, "any")).status).toBe(403);
  expect((await join(ada.id, "never-opened")).status).toBe(404);
});

test("a stopped bot has no screen to watch", async () => {
  const { url, auth, api, createBot } = await setup();
  const bot = await createBot("Ada");
  await api("POST", `/bots/${bot.id}/stop`);

  const res = await fetch(`${url}/bots/${bot.id}/screen`, { headers: auth });

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
