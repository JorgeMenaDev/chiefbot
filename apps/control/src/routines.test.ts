import { afterEach, expect, test } from "bun:test";
import { Bot, ChatEvent, ClientEvent, Routine, SignInResponse, type BotId, type RoutineInput } from "@chiefbot/contracts";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { fakeCopilot, sdk } from "@chiefbot/worker/fake-copilot";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "./clock.ts";
import type { ComputerProvider } from "./computers/computer.ts";
import { fakeComputers } from "./computers/fakeComputers.ts";
import { startControl } from "./control.ts";
import { WORKER_TIMEOUT_MS } from "./routines.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

// 15 Oct 2026, 07:00 UTC: 08:00 in London (BST).
const start = Date.parse("2026-10-15T07:00:00Z");
const nineLondon = Date.parse("2026-10-15T08:00:00Z");
const daily: RoutineInput = { prompt: "Summarise my inbox", cron: "0 9 * * *", timezone: "Europe/London" };

// Control on a fake clock, with bot computers whose workers run a fake Copilot.
// `down` stops control; `up` starts it again on the same port, database and clock.
async function setup({ provider }: { provider?: (fake: ComputerProvider) => ComputerProvider } = {}) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "chiefbot-routines-")), "control.sqlite");
  const github = startFakeGitHub();
  const time = fakeClock(start);
  const computers = fakeComputers({ copilot: fakeCopilot() });
  const options = {
    port: 0,
    dbPath,
    githubApiUrl: github.url,
    computers: provider ? provider(computers.provider) : computers.provider,
    clock: time.clock,
  };
  let control = startControl(options);
  stops.push(github.stop, computers.stopAll, () => control.stop());
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({ accessToken, accessTokenExpiresAt: start + 8 * 3600_000, refreshToken, refreshTokenExpiresAt: 0 }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  const auth = { authorization: `Bearer ${sessionToken}` };
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${control.url}${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  const bots = async () => ClientEvent.parse(await nextMessage(control.url, auth, "/events")).bots;
  const statusOf = async (botId: BotId) => (await bots()).find((bot) => bot.id === botId)?.status;
  // A new bot, once its worker is connected, then stopped unless `running`.
  const bot = async ({ running = false } = {}) => {
    const created = Bot.parse(await (await api("POST", "/bots", { name: "Ada" })).json());
    await eventually(async () => (await statusOf(created.id)) === "online");
    if (!running) await api("POST", `/bots/${created.id}/stop`);
    return created;
  };
  const addRoutine = async (botId: BotId, input: RoutineInput = daily) => {
    const res = await api("POST", `/bots/${botId}/routines`, input);
    expect(res.status).toBe(201);
    return Routine.parse(await res.json());
  };
  const routines = async (botId: BotId) => Routine.array().parse(await (await api("GET", `/bots/${botId}/routines`)).json());
  const chat = async (botId: BotId) =>
    (await allMessages(control.url, auth, `/bots/${botId}/chat`)).map((message) => ChatEvent.parse(message).event);
  const port = Number(new URL(control.url).port);
  const down = () => control.stop();
  const up = () => void (control = startControl({ ...options, port }));

  return { time, computers, api, bot, statusOf, addRoutine, routines, chat, down, up };
}

// Opens a WebSocket on control and resolves with its first message.
function nextMessage(controlUrl: string, headers: Record<string, string>, path: string) {
  return new Promise<unknown>((resolve) => {
    const socket = new WebSocket(`${controlUrl.replace("http", "ws")}${path}`, { headers });
    socket.onmessage = (event) => {
      socket.close();
      resolve(JSON.parse(String(event.data)));
    };
  });
}

// Every message a WebSocket on control sends within 50 ms of opening.
function allMessages(controlUrl: string, headers: Record<string, string>, path: string) {
  return new Promise<unknown[]>((resolve) => {
    const messages: unknown[] = [];
    const socket = new WebSocket(`${controlUrl.replace("http", "ws")}${path}`, { headers });
    socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    socket.onopen = () =>
      setTimeout(() => {
        socket.close();
        resolve(messages);
      }, 50);
  });
}

// Resolves once check passes, failing after two real seconds.
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await Bun.sleep(10);
  }
}

test("at its due time a routine starts the stopped bot, runs the prompt as a turn, and stops the bot again", async () => {
  const { time, computers, bot, statusOf, addRoutine, routines, chat } = await setup();
  const ada = await bot();
  const routine = await addRoutine(ada.id);
  expect(routine.nextDueAt).toBe(nineLondon);

  time.advance(nineLondon - start);

  await eventually(async () => (await routines(ada.id))[0]?.lastRun?.status === "succeeded");
  expect(await chat(ada.id)).toContainEqual({ type: "user-message", text: "Summarise my inbox" });
  expect(await chat(ada.id)).toContainEqual({ type: "text-delta", messageId: "msg-1", text: "Summarise my inbox" });
  expect(await statusOf(ada.id)).toBe("stopped");
  expect(await computers.provider.status(ada.id)).toBe("stopped");
  expect((await routines(ada.id))[0]?.nextDueAt).toBe(nineLondon + 86400_000);
});

test("a routine on a running bot leaves it running", async () => {
  const { time, bot, statusOf, addRoutine, routines } = await setup();
  const ada = await bot({ running: true });
  await addRoutine(ada.id);

  time.advance(nineLondon - start);

  await eventually(async () => (await routines(ada.id))[0]?.lastRun?.status === "succeeded");
  expect(await statusOf(ada.id)).toBe("online");
});

test("due times missed while control was down run once when it is back", async () => {
  const { time, bot, addRoutine, routines, chat, down, up } = await setup();
  const ada = await bot();
  await addRoutine(ada.id, { ...daily, cron: "0 * * * *" });
  const prompts = async () => (await chat(ada.id)).filter((event) => event.type === "user-message").length;
  time.advance(3600_000);
  await eventually(async () => (await routines(ada.id))[0]?.lastRun?.status === "succeeded");

  // Down over three due times (09:00, 10:00 and 11:00 UTC), then back at 11:01.
  down();
  time.advance(3 * 3600_000 + 60_000);
  up();
  await eventually(async () => (await routines(ada.id))[0]?.lastRun?.dueAt === start + 2 * 3600_000);
  await eventually(async () => (await routines(ada.id))[0]?.lastRun?.status === "succeeded");
  expect(await prompts()).toBe(2);
});

test("a run cut short by a control restart is marked failed, its computer is stopped again, and it never runs twice", async () => {
  const { time, computers, bot, statusOf, addRoutine, routines, chat, down, up } = await setup();
  const ada = await bot();
  await addRoutine(ada.id);
  let release = () => {};
  computers.copilot.script = async function* () {
    yield sdk.delta("msg-1", "Working on it");
    await new Promise<void>((resolve) => (release = resolve));
    yield sdk.idle();
  };
  time.advance(nineLondon - start);
  await eventually(async () => (await routines(ada.id))[0]?.lastRun?.turnId != null);

  down();
  release();
  up();
  time.advance(1000);

  await eventually(async () => (await routines(ada.id))[0]?.lastRun?.status === "failed");
  expect((await routines(ada.id))[0]?.lastRun?.error).toBe("Control restarted before this run finished.");
  await eventually(async () => (await statusOf(ada.id)) === "stopped");
  expect(await computers.provider.status(ada.id)).toBe("stopped");
  expect((await chat(ada.id)).filter((event) => event.type === "user-message")).toHaveLength(1);
});

test("a computer whose worker never comes online fails the run and is stopped again", async () => {
  const { time, computers, bot, statusOf, addRoutine, routines } = await setup({
    // Starting the computer the first time works; after that its worker never connects.
    provider: (fake) => {
      let starts = 0;
      return { ...fake, start: async (botId) => (++starts === 1 ? fake.start(botId) : undefined) };
    },
  });
  const ada = await bot();
  await addRoutine(ada.id);
  time.advance(nineLondon - start);
  await eventually(async () => (await statusOf(ada.id)) === "starting");

  time.advance(WORKER_TIMEOUT_MS);

  await eventually(async () => (await routines(ada.id))[0]?.lastRun?.status === "failed");
  expect((await routines(ada.id))[0]?.lastRun?.error).toBe("The bot's computer did not come online in time.");
  await eventually(async () => (await statusOf(ada.id)) === "stopped");
  expect(computers.computers.get(ada.id)?.worker).toBeNull();
});

test("a routine is skipped, not retried, while someone has taken over the bot's screen", async () => {
  const { time, api, bot, addRoutine, routines, chat } = await setup();
  const ada = await bot({ running: true });
  await addRoutine(ada.id);
  await api("POST", `/bots/${ada.id}/take-over`);

  time.advance(nineLondon - start);

  await eventually(async () => (await routines(ada.id))[0]?.lastRun?.status === "skipped");
  expect((await routines(ada.id))[0]?.lastRun?.error).toBe("Someone had taken over the bot's screen.");
  time.advance(60_000);
  await Bun.sleep(50);
  expect(await chat(ada.id)).toEqual([]);
});

test("routines are created, edited and deleted per bot, and a schedule control cannot run is refused", async () => {
  const { api, bot, addRoutine, routines } = await setup();
  const ada = await bot({ running: true });
  const routine = await addRoutine(ada.id);

  const edited = await api("PUT", `/bots/${ada.id}/routines/${routine.id}`, { ...daily, timezone: "America/New_York" });
  const badCron = await api("POST", `/bots/${ada.id}/routines`, { ...daily, cron: "every morning" });
  const badZone = await api("POST", `/bots/${ada.id}/routines`, { ...daily, timezone: "Mars/Olympus_Mons" });
  const never = await api("POST", `/bots/${ada.id}/routines`, { ...daily, cron: "0 9 30 2 *" });

  // 09:00 in New York is 13:00 UTC.
  expect(Routine.parse(await edited.json()).nextDueAt).toBe(Date.parse("2026-10-15T13:00:00Z"));
  for (const refused of [badCron, badZone, never]) {
    expect([refused.status, await refused.json()]).toEqual([400, { error: "invalid_schedule" }]);
  }
  expect((await api("DELETE", `/bots/${ada.id}/routines/${routine.id}`)).status).toBe(204);
  expect(await routines(ada.id)).toEqual([]);
  expect((await api("DELETE", `/bots/${ada.id}/routines/${routine.id}`)).status).toBe(404);
});
