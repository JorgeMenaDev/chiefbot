import { afterEach, expect, test } from "bun:test";
import { Bot, ChatEvent, ClientEvent, SendMessageResponse, SignInResponse, type BotId } from "@chiefbot/contracts";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { fakeCopilot, sdk } from "@chiefbot/worker/fake-copilot";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControl } from "./control.ts";
import { fakeComputers } from "./computers/fakeComputers.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

// Control with a fake GitHub, and bot computers whose workers run a fake Copilot.
async function setup({ dbPath = ":memory:" }: { dbPath?: string } = {}) {
  const github = startFakeGitHub();
  const copilot = fakeCopilot();
  const computers = fakeComputers({ copilot });
  const control = startControl({ port: 0, dbPath, githubApiUrl: github.url, computers: computers.provider });
  stops.push(github.stop, computers.stopAll, control.stop);
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({
      accessToken,
      accessTokenExpiresAt: Date.now() + 8 * 3600_000,
      refreshToken,
      refreshTokenExpiresAt: Date.now() + 180 * 86400_000,
    }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  const auth = { authorization: `Bearer ${sessionToken}` };
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${control.url}${path}`, {
      method,
      headers: auth,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  // A new bot, once its worker is connected.
  const onlineBot = async (name: string) => {
    const bot = Bot.parse(await (await api("POST", "/bots", { name })).json());
    await until(control.url, auth, "/events", (event) => {
      const message = ClientEvent.parse(event);
      return message.type === "bots" && message.bots.some(({ id, status }) => id === bot.id && status === "online");
    });
    return bot;
  };
  const send = async (botId: BotId, text: string) => {
    const res = await api("POST", `/bots/${botId}/messages`, { text });
    if (res.status !== 202) throw new Error(`send failed: ${res.status} ${await res.text()}`);
    return SendMessageResponse.parse(await res.json()).turnId;
  };
  return { github, copilot, computers, control, accessToken, auth, api, onlineBot, send };
}

// Opens a WebSocket on control and resolves once a message matches, failing after a second.
function until(controlUrl: string, headers: Record<string, string>, path: string, matches: (message: unknown) => boolean) {
  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`${controlUrl.replace("http", "ws")}${path}`, { headers });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no match on ${path}`));
    }, 1000);
    socket.onmessage = (event) => {
      if (!matches(JSON.parse(String(event.data)))) return;
      clearTimeout(timer);
      socket.close();
      resolve();
    };
  });
}

// The desktop's view of one bot's chat: every ChatEvent the chat socket sent.
function watchChat(controlUrl: string, headers: Record<string, string>, botId: BotId, after = 0) {
  const socket = new WebSocket(`${controlUrl.replace("http", "ws")}/bots/${botId}/chat?after=${after}`, { headers });
  stops.push(() => socket.close());
  const events: ChatEvent[] = [];
  const waiters = new Set<() => void>();
  socket.onmessage = (event) => {
    events.push(ChatEvent.parse(JSON.parse(String(event.data))));
    for (const wake of waiters) wake();
  };
  return {
    events,
    // Resolves with all events once they match, failing after two seconds.
    until(matches: (events: ChatEvent[]) => boolean) {
      return new Promise<ChatEvent[]>((resolve, reject) => {
        const check = () => {
          if (!matches(events)) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(events);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`chat never matched; got: ${JSON.stringify(events.map((e) => e.event))}`));
        }, 2000);
        waiters.add(check);
        check();
      });
    },
  };
}

const doneCount = (n: number) => (events: ChatEvent[]) => events.filter((e) => e.event.type === "done").length >= n;

test("a message runs a Copilot turn on the bot's worker and the reply streams to the chat", async () => {
  const { control, copilot, accessToken, auth, onlineBot, send } = await setup();
  const bot = await onlineBot("Ada");
  const chat = watchChat(control.url, auth, bot.id);

  const turnId = await send(bot.id, "hi");

  const events = await chat.until(doneCount(1));
  expect(events.every((e) => e.turnId === turnId)).toBe(true);
  expect(events.map((e) => e.event)).toEqual([
    { type: "user-message", text: "hi" },
    { type: "status", text: "Answering" },
    { type: "tool-call", toolCallId: "tool-1", name: "Echo", status: "running" },
    { type: "tool-call", toolCallId: "tool-1", name: "Echo", status: "succeeded" },
    { type: "text-delta", messageId: "msg-1", text: "You said: " },
    { type: "text-delta", messageId: "msg-1", text: "hi" },
    { type: "done" },
  ]);
  // The SDK session got the owner's access token from control's broker.
  expect(copilot.tokens).toEqual([accessToken]);
});

// A fake Copilot script that streams "Hello" and "world", pausing in between until release().
function pausedReply() {
  let release = () => {};
  const paused = new Promise<void>((resolve) => (release = resolve));
  async function* script() {
    yield sdk.delta("msg-1", "Hello ");
    await paused;
    yield sdk.delta("msg-1", "world");
    yield sdk.idle();
  }
  return { script, release };
}

test("history survives a control restart, and a turn the worker runs meanwhile still lands", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "chiefbot-control-")), "control.sqlite");
  const { github, computers, control, auth, onlineBot, send } = await setup({ dbPath });
  const bot = await onlineBot("Ada");
  await send(bot.id, "first");
  await watchChat(control.url, auth, bot.id).until(doneCount(1));
  const reply = pausedReply();
  computers.copilot.script = reply.script;
  const turnId = await send(bot.id, "second");
  const before = await watchChat(control.url, auth, bot.id).until((events) => events.at(-1)?.event.type === "text-delta");

  control.stop();
  reply.release();
  const restarted = startControl({ port: Number(new URL(control.url).port), dbPath, githubApiUrl: github.url, computers: computers.provider });
  stops.push(restarted.stop);

  // A desktop that reconnects with its cursor gets only what it missed.
  const resumed = await watchChat(restarted.url, auth, bot.id, before.at(-1)?.seq).until(doneCount(1));
  expect(resumed.map((e) => [e.turnId, e.event])).toEqual([
    [turnId, { type: "text-delta", messageId: "msg-1", text: "world" }],
    [turnId, { type: "done" }],
  ]);
  // A fresh desktop gets the whole history.
  const all = await watchChat(restarted.url, auth, bot.id).until(doneCount(2));
  expect(all.filter((e) => e.event.type === "user-message").map((e) => e.event)).toEqual([
    { type: "user-message", text: "first" },
    { type: "user-message", text: "second" },
  ]);
});

test("a turn whose worker restarts ends with an error, and the bot takes the next message", async () => {
  const { computers, control, auth, onlineBot, send } = await setup();
  const bot = await onlineBot("Ada");
  computers.copilot.script = pausedReply().script;
  const lost = await send(bot.id, "never finishes");
  const chat = watchChat(control.url, auth, bot.id);
  await chat.until((events) => events.some((e) => e.event.type === "text-delta"));

  await computers.provider.stop(bot.id);
  await computers.provider.start(bot.id);

  await chat.until(doneCount(1));
  expect(chat.events.filter((e) => e.turnId === lost).map((e) => e.event.type)).toEqual([
    "user-message",
    "text-delta",
    "error",
    "done",
  ]);
  computers.copilot.script = fakeCopilot().script;
  await send(bot.id, "again");
  await chat.until(doneCount(2));
});

test("a message is refused while the bot is offline or still on a turn", async () => {
  const { api, computers, onlineBot, send } = await setup();
  const bot = await onlineBot("Ada");
  computers.copilot.script = pausedReply().script;
  await send(bot.id, "busy");

  const busy = await api("POST", `/bots/${bot.id}/messages`, { text: "and this?" });
  await api("POST", `/bots/${bot.id}/stop`);
  const offline = await api("POST", `/bots/${bot.id}/messages`, { text: "hello?" });

  expect([busy.status, await busy.json()]).toEqual([409, { error: "turn_running" }]);
  expect([offline.status, await offline.json()]).toEqual([409, { error: "bot_offline" }]);
});

test("the token broker gives a bot's worker its owner's access token only, and nobody else anything", async () => {
  const { control, computers, auth, onlineBot } = await setup();
  const ada = await onlineBot("Ada");
  const grace = await onlineBot("Grace");
  const tokenOf = (botId: BotId) => computers.computers.get(botId)?.spec.env.CHIEFBOT_BOT_TOKEN ?? "";
  const broker = (botId: BotId, bearer: string) =>
    fetch(`${control.url}/worker/${botId}/github-token`, { headers: { authorization: `Bearer ${bearer}` } });

  const own = await broker(ada.id, tokenOf(ada.id));
  const text = await own.text();

  expect(own.status).toBe(200);
  expect(text).not.toContain("ghr_");
  expect((await broker(ada.id, tokenOf(grace.id))).status).toBe(403);
  expect((await broker(ada.id, auth.authorization.slice("Bearer ".length))).status).toBe(401);
});

test("a reply that did not stream still shows, sub-agent chatter stays out, and a session error ends the turn", async () => {
  const { control, computers, auth, onlineBot, send } = await setup();
  const bot = await onlineBot("Ada");
  computers.copilot.script = async function* () {
    yield sdk.delta("sub-msg", "thinking out loud", "sub-agent-1");
    yield sdk.message("msg-2", "Whole reply");
    yield sdk.error("Rate limited");
  };

  await send(bot.id, "go");

  const events = await watchChat(control.url, auth, bot.id).until(doneCount(1));
  expect(events.map((e) => e.event)).toEqual([
    { type: "user-message", text: "go" },
    { type: "text-delta", messageId: "msg-2", text: "Whole reply" },
    { type: "error", message: "Rate limited" },
    { type: "done" },
  ]);
});
