import { Bot, ChatEvent, ClientEvent, SendMessageResponse, SignInResponse, type BotId } from "@chiefbot/contracts";
import { startFakeGitHub, type FakeGitHubUser } from "@chiefbot/fake-github";
import { fakeCopilot, type FakeCopilot } from "@chiefbot/worker/fake-copilot";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "./clock.ts";
import type { ComputerProvider } from "./computers/computer.ts";
import { fakeComputers } from "./computers/fakeComputers.ts";
import { startControl } from "./control.ts";

// Shared fixtures for control's tests: control with a fake GitHub and fake bot
// computers (their workers run a fake Copilot), a signed-in user acting through
// control's HTTP and WebSocket API, and waits. Each test file runs
// `afterEach(cleanUp)`, which stops everything a test started.

const stops: Array<() => unknown> = [];

// Stops what the last test started, newest first.
export function cleanUp() {
  for (const stop of stops.splice(0).reverse()) stop();
}

// Runs `stop` at the end of the test, with the rest of cleanUp.
export const atCleanUp = (stop: () => unknown) => void stops.push(stop);

export const hour = 3600_000;

export type TestControlOptions = {
  // A fresh SQLite file that survives a control restart. Default: in memory.
  persistent?: boolean;
  // The fake GitHub's user. Default: defaultFakeUser.
  user?: FakeGitHubUser;
  // The workers' Copilot. Default: fakeCopilot() echoing each prompt.
  copilot?: FakeCopilot;
  // Where the workers serve git (fakeComputers).
  gitSocket?: string;
  // Wraps the fake provider, e.g. to make start fail.
  provider?: (fake: ComputerProvider) => ComputerProvider;
  clock?: Clock;
  idleStopMinutes?: number;
  // How long the signed-in user's GitHub tokens have left.
  accessTokenLeftMs?: number;
  refreshTokenLeftMs?: number;
};

// Starts control and signs the fake GitHub's user in. `restart` stops control
// and starts it again on the same port, database and clock.
export async function startTestControl({
  persistent = false,
  user: githubUser,
  copilot = fakeCopilot(),
  gitSocket,
  provider,
  clock,
  idleStopMinutes,
  accessTokenLeftMs = 8 * hour,
  refreshTokenLeftMs = 180 * 24 * hour,
}: TestControlOptions = {}) {
  const github = startFakeGitHub(githubUser ? { user: githubUser } : {});
  const computers = fakeComputers({ copilot, ...(gitSocket === undefined ? {} : { gitSocket }) });
  const options = {
    port: 0,
    dbPath: persistent ? join(mkdtempSync(join(tmpdir(), "chiefbot-control-")), "control.sqlite") : ":memory:",
    githubApiUrl: github.url,
    githubClientId: "test-client",
    computers: provider ? provider(computers.provider) : computers.provider,
    ...(clock === undefined ? {} : { clock }),
    ...(idleStopMinutes === undefined ? {} : { idleStopMinutes }),
  };
  let control = startControl(options);
  const url = control.url;
  stops.push(github.stop, computers.stopAll, () => control.stop());

  // Signs `as` (default: the fake's user) in to control, as the desktop does.
  const signIn = async (as?: FakeGitHubUser) => {
    const tokens = github.issueTokens(as);
    const res = await fetch(`${url}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        ...tokens,
        accessTokenExpiresAt: Date.now() + accessTokenLeftMs,
        refreshTokenExpiresAt: Date.now() + refreshTokenLeftMs,
      }),
    });
    return { tokens, ...userApi(url, SignInResponse.parse(await res.json()).sessionToken) };
  };

  const stopControl = () => control.stop();
  const startAgain = () => void (control = startControl({ ...options, port: Number(new URL(url).port) }));

  return {
    github,
    computers,
    copilot,
    url,
    user: await signIn(),
    signIn,
    stopControl,
    startControl: startAgain,
    restart() {
      stopControl();
      startAgain();
    },
    // The credential control handed the bot's computer.
    botToken: (botId: BotId) => computers.computers.get(botId)?.spec.env.CHIEFBOT_BOT_TOKEN ?? "",
  };
}

export type TestControl = Awaited<ReturnType<typeof startTestControl>>;

// What a signed-in user does through control's API with their session.
function userApi(url: string, sessionToken: string) {
  const auth = { authorization: `Bearer ${sessionToken}` };
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${url}${path}`, {
      method,
      headers: { ...auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const watchBots = () => watchBotList(url, auth);
  const createBot = async (name: string) => Bot.parse(await (await api("POST", "/bots", { name })).json());
  return {
    sessionToken,
    auth,
    api,
    createBot,
    watchBots,
    watchChat: (botId: BotId, after = 0) => watchChat(url, auth, botId, after),
    // A new bot, once its worker is connected.
    async onlineBot(name: string) {
      const bot = await createBot(name);
      await watchBots().until((bots) => bots.some(({ id, status }) => id === bot.id && status === "online"));
      return bot;
    },
    // Sends a chat message; resolves with its turn once control accepts it.
    async send(botId: BotId, text: string) {
      const res = await api("POST", `/bots/${botId}/messages`, { text });
      if (res.status !== 202) throw new Error(`send failed: ${res.status} ${await res.text()}`);
      return SendMessageResponse.parse(await res.json()).turnId;
    },
    // The user's bots right now: the first list /events sends.
    bots: () => watchBots().until(() => true),
    statusOf: async (botId: BotId) => (await watchBots().until(() => true)).find((bot) => bot.id === botId)?.status,
    // The bot's whole chat history right now.
    chat: async (botId: BotId) => (await watchChat(url, auth, botId).settled()).map(({ event }) => event),
  };
}

export type TestUser = ReturnType<typeof userApi>;

// The desktop's view of the user's bots: the /events WebSocket's latest list.
function watchBotList(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(`${url.replace("http", "ws")}/events`, { headers });
  stops.push(() => socket.close());
  let latest: Bot[] | null = null;
  const waiters = new Set<() => void>();
  socket.onmessage = (event) => {
    const message = ClientEvent.parse(JSON.parse(String(event.data)));
    if (message.type !== "bots") return;
    latest = message.bots;
    for (const wake of waiters) wake();
  };
  return {
    // Resolves with the list once it matches, failing after two seconds.
    until: (matches: (bots: Bot[]) => boolean) =>
      waitFor(() => (latest && matches(latest) ? latest : null), waiters, () => `bots never matched; last: ${JSON.stringify(latest)}`),
  };
}

// The desktop's view of one bot's chat: every ChatEvent the chat socket sent after `after`.
function watchChat(url: string, headers: Record<string, string>, botId: BotId, after = 0) {
  const socket = new WebSocket(`${url.replace("http", "ws")}/bots/${botId}/chat?after=${after}`, { headers });
  stops.push(() => socket.close());
  const opened = new Promise((resolve) => (socket.onopen = resolve));
  const events: ChatEvent[] = [];
  const waiters = new Set<() => void>();
  socket.onmessage = (event) => {
    events.push(ChatEvent.parse(JSON.parse(String(event.data))));
    for (const wake of waiters) wake();
  };
  return {
    events,
    // Resolves with all events once they match, failing after five seconds.
    until: (matches: (events: ChatEvent[]) => boolean) =>
      waitFor(
        () => (matches(events) ? events : null),
        waiters,
        () => `chat never matched; got: ${JSON.stringify(events.map((e) => e.event))}`,
        5000,
      ),
    // Resolves with the events sent within 50 ms of opening: the history so far.
    settled: async () => {
      await opened;
      await Bun.sleep(50);
      return events;
    },
  };
}

// Resolves with found()'s first non-null value, checked now and on every wake.
function waitFor<T>(found: () => T | null, waiters: Set<() => void>, failure: () => string, ms = 2000) {
  return new Promise<T>((resolve, reject) => {
    const check = () => {
      const value = found();
      if (value === null) return;
      waiters.delete(check);
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(failure()));
    }, ms);
    waiters.add(check);
    check();
  });
}

// Resolves once check passes, failing after two real seconds.
export async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await Bun.sleep(10);
  }
}

// A chat matcher: at least n turns are done.
export const doneCount = (n: number) => (events: ChatEvent[]) => events.filter((e) => e.event.type === "done").length >= n;
