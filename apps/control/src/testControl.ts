import {
  Bot,
  ChatEvent,
  ClientEvent,
  ControlToCoordinator,
  SendMessageResponse,
  SignInResponse,
  type BotId,
  type CoordinatorToControl,
  type ProjectId,
  type TurnEvent,
  type TurnId,
} from "@chiefbot/contracts";
import { startFakeGitHub, type FakeGitHubUser } from "@chiefbot/fake-github";
import { fakeCopilot, type FakeCopilot } from "@chiefbot/worker/fake-copilot";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "@chiefbot/worker/clock";
import type { CopilotTokenMinter } from "./copilotIdentity.ts";
import type { ComputerProvider } from "./computers/computer.ts";
import { fakeComputers } from "./computers/fakeComputers.ts";
import { startControl } from "./control.ts";
import type { SecretStore } from "./secrets/secretStore.ts";

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
  // Where the workers serve git's credential helper (fakeComputers).
  gitSocket?: string;
  // Wraps the fake provider, e.g. to make start fail.
  provider?: (fake: ComputerProvider) => ComputerProvider;
  clock?: Clock;
  idleStopMinutes?: number;
  // Mints organizations' Copilot tokens. Default: the repo app's, against the fake GitHub.
  copilotTokens?: CopilotTokenMinter;
  // Where control keeps secrets. Default: control's own encrypted store.
  secrets?: SecretStore;
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
  copilotTokens,
  secrets,
  accessTokenLeftMs = 8 * hour,
  refreshTokenLeftMs = 180 * 24 * hour,
}: TestControlOptions = {}) {
  const github = startFakeGitHub(githubUser ? { user: githubUser } : {});
  const computers = fakeComputers({ copilot, ...(gitSocket === undefined ? {} : { gitSocket }), ...(clock === undefined ? {} : { clock }) });
  const options = {
    port: 0,
    dbPath: persistent ? join(mkdtempSync(join(tmpdir(), "chiefbot-control-")), "control.sqlite") : ":memory:",
    githubApiUrl: github.url,
    githubClientId: "test-client",
    githubApp: github.app,
    computers: provider ? provider(computers.provider) : computers.provider,
    ...(clock === undefined ? {} : { clock }),
    ...(idleStopMinutes === undefined ? {} : { idleStopMinutes }),
    ...(copilotTokens === undefined ? {} : { copilotTokens }),
    ...(secrets === undefined ? {} : { secrets }),
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
    // Control's SQLite file, for a test that changes it while control is stopped.
    dbPath: options.dbPath,
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
    watchChat: (botId: BotId, after = 0) => watchChat(url, auth, `/bots/${botId}/chat?after=${after}`),
    // The user's own chat with a project's coordinator.
    watchProjectChat: (projectId: ProjectId, after = 0) => watchChat(url, auth, `/projects/${projectId}/chat?after=${after}`),
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
    chat: async (botId: BotId) => (await watchChat(url, auth, `/bots/${botId}/chat`).settled()).map(({ event }) => event),
  };
}

export type TestUser = ReturnType<typeof userApi>;

// Stands in for the project's coordinator: its computer stops, and this socket
// connects with the project's credential instead. It sees what control sends,
// and speaks for the coordinator.
export async function fakeCoordinator({ url, computers }: TestControl, projectId: ProjectId) {
  await computers.provider.stop(projectId);
  const token = computers.computers.get(projectId)?.spec.env.CHIEFBOT_PROJECT_TOKEN ?? "";
  const received: ControlToCoordinator[] = [];
  const waiters = new Set<() => void>();
  let socket: WebSocket;
  const connect = async () => {
    socket = new WebSocket(`${url.replace("http", "ws")}/coordinator/${projectId}`, { headers: { authorization: `Bearer ${token}` } });
    socket.onmessage = (message) => {
      received.push(ControlToCoordinator.parse(JSON.parse(String(message.data))));
      for (const wake of waiters) wake();
    };
    await new Promise((resolve) => (socket.onopen = resolve));
  };
  await connect();
  atCleanUp(() => socket.close());
  const send = (message: CoordinatorToControl) => socket.send(JSON.stringify(message));
  // The nth message of `type` control sent (1 for the first), once it arrives.
  const nth = <Type extends ControlToCoordinator["type"]>(type: Type, n = 1) =>
    new Promise<Extract<ControlToCoordinator, { type: Type }>>((resolve, reject) => {
      const check = () => {
        const found = received.filter((message): message is Extract<ControlToCoordinator, { type: Type }> => message.type === type)[n - 1];
        if (!found) return;
        waiters.delete(check);
        clearTimeout(timer);
        resolve(found);
      };
      const timer = setTimeout(() => reject(new Error(`no ${type} #${n}; got ${JSON.stringify(received)}`)), 2000);
      waiters.add(check);
      check();
    });
  let index = 0;
  return {
    token,
    nth,
    hello: (activeTurnId: TurnId | null) => send({ type: "hello", activeTurnId }),
    // The turn's next event; the first one of a turn is number 0.
    event: (turnId: TurnId, event: TurnEvent, from?: number) => send({ type: "turn-event", turnId, index: from ?? index++, event }),
    newTurn: () => void (index = 0),
    reconnect: connect,
  };
}


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

// The desktop's view of one chat (a bot's, or the user's with a project's
// coordinator): every ChatEvent the chat socket at `path` sent.
function watchChat(url: string, headers: Record<string, string>, path: string) {
  const socket = new WebSocket(`${url.replace("http", "ws")}${path}`, { headers });
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
