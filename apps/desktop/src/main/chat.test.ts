import { afterEach, expect, test } from "bun:test";
import { ApprovalId, Bot, BotId, ClientEvent, SignInResponse, TurnId, type ChatView } from "@chiefbot/contracts";
import { startControl } from "@chiefbot/control";
import { fakeComputers } from "@chiefbot/control/fake-computers";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { sdk } from "@chiefbot/worker/fake-copilot";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChats, foldChat } from "./chat.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

// Control on a file database, a signed-in session and one online bot.
async function setup() {
  const dbPath = join(mkdtempSync(join(tmpdir(), "chiefbot-desktop-")), "control.sqlite");
  const github = startFakeGitHub();
  const computers = fakeComputers();
  const control = startControl({ port: 0, dbPath, githubApiUrl: github.url, githubClientId: "test-client", computers: computers.provider });
  stops.push(github.stop, computers.stopAll, control.stop);
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({ accessToken, accessTokenExpiresAt: Date.now() + 3600_000 * 8, refreshToken, refreshTokenExpiresAt: 0 }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  const headers = { authorization: `Bearer ${sessionToken}` };
  const bot = Bot.parse(await (await fetch(`${control.url}/bots`, { method: "POST", headers, body: '{"name":"Ada"}' })).json());
  await new Promise<void>((resolve) => {
    const socket = new WebSocket(`${control.url.replace("http", "ws")}/events`, { headers });
    socket.onmessage = (event) => {
      const message = ClientEvent.parse(JSON.parse(String(event.data)));
      if (message.type !== "bots" || !message.bots.some((b) => b.status === "online")) return;
      socket.close();
      resolve();
    };
  });
  const restartControl = () => {
    control.stop();
    const restarted = startControl({ port: Number(new URL(control.url).port), dbPath, githubApiUrl: github.url, githubClientId: "test-client", computers: computers.provider });
    stops.push(restarted.stop);
  };
  return { control, computers, sessionToken, botId: bot.id, restartControl };
}

// A desktop's chats, as Electron main holds them.
function launch(controlUrl: string, sessionToken: string) {
  let changed = () => {};
  const chats = createChats({ controlUrl, session: () => sessionToken, retryMs: 20, onChange: () => changed() });
  stops.push(chats.disconnect);
  const until = (botId: BotId, matches: (view: ChatView) => boolean) =>
    new Promise<ChatView>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`chat never matched: ${JSON.stringify(chats.view(botId))}`)), 2000);
      changed = () => {
        if (!matches(chats.view(botId))) return;
        clearTimeout(timer);
        resolve(chats.view(botId));
      };
      changed();
    });
  return { chats, until };
}

const idleWith = (count: number) => (view: ChatView) => view.working === null && view.items.length >= count;

test("the chat streams a turn as it runs, and a relaunched desktop shows the same history", async () => {
  const { control, sessionToken, botId } = await setup();
  const desktop = launch(control.url, sessionToken);
  desktop.chats.open(botId);

  await desktop.chats.send(botId, "hi");
  const view = await desktop.until(botId, idleWith(3));

  expect(view.items).toEqual([
    { kind: "user", id: expect.any(String), text: "hi" },
    { kind: "tool", id: expect.any(String), name: "Echo", status: "succeeded" },
    { kind: "assistant", id: expect.any(String), text: "You said: hi" },
  ]);
  const relaunched = launch(control.url, sessionToken);
  relaunched.chats.open(botId);
  expect((await relaunched.until(botId, idleWith(3))).items).toEqual(view.items);
});

test("after control restarts mid-reply, the desktop reconnects and the reply finishes without repeats", async () => {
  const { control, computers, sessionToken, botId, restartControl } = await setup();
  let release = () => {};
  const paused = new Promise<void>((resolve) => (release = resolve));
  computers.copilot.script = async function* () {
    yield sdk.intent("Writing");
    yield sdk.delta("msg-1", "Hello ");
    await paused;
    yield sdk.delta("msg-1", "world");
    yield sdk.idle();
  };
  const desktop = launch(control.url, sessionToken);
  desktop.chats.open(botId);
  await desktop.chats.send(botId, "greet");
  const midway = await desktop.until(botId, (view) => view.items.some((item) => item.kind === "assistant"));
  expect(midway.working).toBe("Writing");

  restartControl();
  release();

  const view = await desktop.until(botId, idleWith(2));
  expect(view.items.map((item) => (item.kind === "assistant" || item.kind === "user" ? item.text : item.kind))).toEqual([
    "greet",
    "Hello world",
  ]);
});

test("a risky command shows as a pending approval card, still pending after a relaunch, and answering it lets the bot go on", async () => {
  const { control, computers, sessionToken, botId } = await setup();
  computers.copilot.script = async function* (_prompt, runtime) {
    await runtime.shell("git push origin main");
    yield sdk.idle();
  };
  const desktop = launch(control.url, sessionToken);
  desktop.chats.open(botId);
  await desktop.chats.send(botId, "push it");
  await desktop.until(botId, (view) => view.items.some((item) => item.kind === "approval"));
  desktop.chats.disconnect();

  const relaunched = launch(control.url, sessionToken);
  relaunched.chats.open(botId);
  const pending = await relaunched.until(botId, (view) => view.items.some((item) => item.kind === "approval"));
  const card = pending.items.find((item) => item.kind === "approval");
  expect(card).toEqual({
    kind: "approval",
    id: expect.any(String),
    approvalId: expect.any(String),
    request: "command",
    detail: "git push origin main",
    state: "pending",
  });
  expect(pending.working).toBe("Waiting for your approval");

  await relaunched.chats.answer(botId, ApprovalId.parse(card?.kind === "approval" ? card.approvalId : ""), false);
  const view = await relaunched.until(botId, (view) => view.working === null);
  expect(view.items.find((item) => item.kind === "approval")).toMatchObject({ state: "declined" });
});

test("an approval nobody answered before its turn ended shows as expired", () => {
  const turnId = TurnId.parse("turn-1");
  const approvalId = ApprovalId.parse("approval-1");
  const events = [
    { type: "user-message", text: "push it" },
    { type: "approval-request", approvalId, kind: "command", detail: "git push" },
    { type: "error", message: "The bot restarted before it finished this message." },
    { type: "done" },
  ] as const;

  const empty: ChatView = { botId: BotId.parse("bot-1"), items: [], working: null };
  const view = events.reduce<ChatView>((view, event, seq) => foldChat(view, { seq, turnId, event }), empty);

  expect(view.items.find((item) => item.kind === "approval")).toMatchObject({ state: "expired" });
});
