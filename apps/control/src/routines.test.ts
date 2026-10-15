import { afterEach, expect, test } from "bun:test";
import { Bot, ChatEvent, ClientEvent, Routine, SignInResponse, type BotId, type RoutineInput } from "@chiefbot/contracts";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { fakeCopilot } from "@chiefbot/worker/fake-copilot";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "./clock.ts";
import type { ComputerProvider } from "./computers/computer.ts";
import { fakeComputers } from "./computers/fakeComputers.ts";
import { startControl } from "./control.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

// 15 Oct 2026, 07:00 UTC: 08:00 in London (BST).
const start = Date.parse("2026-10-15T07:00:00Z");
const nineLondon = Date.parse("2026-10-15T08:00:00Z");
const daily: RoutineInput = { prompt: "Summarise my inbox", cron: "0 9 * * *", timezone: "Europe/London" };

// Control on a fake clock, with bot computers whose workers run a fake Copilot.
// `restart` stops control and starts it again on the same database and clock.
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
  const restart = () => {
    control.stop();
    control = startControl({ ...options, port: Number(new URL(control.url).port) });
  };

  return { time, computers, api, bot, statusOf, addRoutine, routines, chat, restart };
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
