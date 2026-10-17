import { afterEach, expect, test } from "bun:test";
import { ApiError, ControlToWorker, type BotId } from "@chiefbot/contracts";
import { fakeCopilot, sdk } from "@chiefbot/worker/fake-copilot";
import { tmpdir } from "node:os";
import { cleanUp, doneCount, startTestControl } from "./testControl.ts";

afterEach(cleanUp);

// Control with a fake GitHub and a signed-in user, and bot computers whose
// workers run a fake Copilot (shell commands run in a temp directory).
async function setup({ persistent = false } = {}) {
  const control = await startTestControl({
    persistent,
    copilot: fakeCopilot({ shell: { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } } }),
  });
  return { ...control, ...control.user };
}

test("a message runs a Copilot turn on the bot's worker and the reply streams to the chat", async () => {
  const { copilot, user, onlineBot, send, watchChat } = await setup();
  const bot = await onlineBot("Ada");
  const chat = watchChat(bot.id);

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
  expect(copilot.tokens).toEqual([user.tokens.accessToken]);
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
  const { computers, stopControl, startControl, onlineBot, send, watchChat } = await setup({ persistent: true });
  const bot = await onlineBot("Ada");
  await send(bot.id, "first");
  await watchChat(bot.id).until(doneCount(1));
  const reply = pausedReply();
  computers.copilot.script = reply.script;
  const turnId = await send(bot.id, "second");
  const before = await watchChat(bot.id).until((events) => events.at(-1)?.event.type === "text-delta");

  stopControl();
  reply.release();
  startControl();

  // A desktop that reconnects with its cursor gets only what it missed.
  const resumed = await watchChat(bot.id, before.at(-1)?.seq).until(doneCount(1));
  expect(resumed.map((e) => [e.turnId, e.event])).toEqual([
    [turnId, { type: "text-delta", messageId: "msg-1", text: "world" }],
    [turnId, { type: "done" }],
  ]);
  // A fresh desktop gets the whole history.
  const all = await watchChat(bot.id).until(doneCount(2));
  expect(all.filter((e) => e.event.type === "user-message").map((e) => e.event)).toEqual([
    { type: "user-message", text: "first" },
    { type: "user-message", text: "second" },
  ]);
});

test("a turn whose worker restarts ends with an error, and the bot takes the next message", async () => {
  const { computers, onlineBot, send, watchChat } = await setup();
  const bot = await onlineBot("Ada");
  computers.copilot.script = pausedReply().script;
  const lost = await send(bot.id, "never finishes");
  const chat = watchChat(bot.id);
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

  expect([busy.status, ApiError.parse(await busy.json())]).toEqual([409, { error: "turn_running" }]);
  expect([offline.status, ApiError.parse(await offline.json())]).toEqual([409, { error: "bot_offline" }]);
});

test("the agent waits while the human has the screen: a message is refused until hand-back", async () => {
  const { api, onlineBot } = await setup();
  const bot = await onlineBot("Ada");

  await api("POST", `/bots/${bot.id}/take-over`);
  const waiting = await api("POST", `/bots/${bot.id}/messages`, { text: "go on" });
  await api("POST", `/bots/${bot.id}/hand-back`);
  const resumed = await api("POST", `/bots/${bot.id}/messages`, { text: "go on" });

  expect([waiting.status, ApiError.parse(await waiting.json())]).toEqual([409, { error: "human_has_screen" }]);
  expect(resumed.status).toBe(202);
});

test("taking over pauses a running turn: its next tool call waits until hand-back", async () => {
  const { api, computers, onlineBot, send, watchChat } = await setup();
  const bot = await onlineBot("Ada");
  let release = () => {};
  const paused = new Promise<void>((resolve) => (release = resolve));
  const ran: string[] = [];
  computers.copilot.script = async function* (_prompt, runtime) {
    yield sdk.delta("msg-1", "Opening the browser");
    await paused;
    ran.push((await runtime.shell("echo clicked")).output);
    yield sdk.idle();
  };
  const chat = watchChat(bot.id);
  await send(bot.id, "go");
  await chat.until((events) => events.some((e) => e.event.type === "text-delta"));

  await api("POST", `/bots/${bot.id}/take-over`);
  for (let i = 0; computers.computers.get(bot.id)?.worker?.screenControl() !== "human"; i++) {
    if (i > 100) throw new Error("the worker never heard of the take-over");
    await Bun.sleep(10);
  }
  release();
  await Bun.sleep(100);
  expect(ran).toEqual([]);

  await api("POST", `/bots/${bot.id}/hand-back`);
  await chat.until(doneCount(1));
  expect(ran).toEqual(["clicked\n"]);
});

test("an approval answered while the human has the screen runs its tool call only after hand-back", async () => {
  const { api, computers, onlineBot, send, watchChat } = await setup();
  const bot = await onlineBot("Ada");
  const ran: string[] = [];
  computers.copilot.script = async function* (_prompt, runtime) {
    if (await runtime.mcp("github", "Merge pull request", false)) ran.push("merged");
    yield sdk.idle();
  };
  const chat = watchChat(bot.id);
  await send(bot.id, "merge it");
  const request = (await chat.until((events) => events.some((e) => e.event.type === "approval-request"))).find(
    (e) => e.event.type === "approval-request",
  );

  await api("POST", `/bots/${bot.id}/take-over`);
  for (let i = 0; computers.computers.get(bot.id)?.worker?.screenControl() !== "human"; i++) {
    if (i > 100) throw new Error("the worker never heard of the take-over");
    await Bun.sleep(10);
  }
  await api("POST", `/bots/${bot.id}/approvals/${request?.event.type === "approval-request" ? request.event.approvalId : ""}`, {
    approved: true,
  });
  await chat.until((events) => events.some((e) => e.event.type === "approval-answer"));
  await Bun.sleep(100);
  expect(ran).toEqual([]);

  await api("POST", `/bots/${bot.id}/hand-back`);
  await chat.until(doneCount(1));
  expect(ran).toEqual(["merged"]);
});

test("the token broker gives a bot's worker its owner's access token only, and nobody else anything", async () => {
  const { url, botToken, auth, onlineBot } = await setup();
  const ada = await onlineBot("Ada");
  const grace = await onlineBot("Grace");
  const broker = (botId: BotId, bearer: string) =>
    fetch(`${url}/worker/${botId}/github-token`, { headers: { authorization: `Bearer ${bearer}` } });

  const own = await broker(ada.id, botToken(ada.id));
  const text = await own.text();

  expect(own.status).toBe(200);
  expect(text).not.toContain("ghr_");
  expect((await broker(ada.id, botToken(grace.id))).status).toBe(403);
  expect((await broker(ada.id, auth.authorization.slice("Bearer ".length))).status).toBe(401);
});

test("a worker reads only its own bot's approval answers, whatever turn it names", async () => {
  const { url, api, computers, botToken, onlineBot, send, watchChat } = await setup();
  computers.copilot.script = async function* (_prompt, runtime) {
    await runtime.mcp("github", "Merge pull request", false);
    yield sdk.idle();
  };
  const ada = await onlineBot("Ada");
  const grace = await onlineBot("Grace");
  const chat = watchChat(ada.id);
  const adaTurn = await send(ada.id, "merge it");
  const request = (await chat.until((events) => events.some((e) => e.event.type === "approval-request"))).find(
    (e) => e.event.type === "approval-request",
  );
  await api("POST", `/bots/${ada.id}/approvals/${request?.event.type === "approval-request" ? request.event.approvalId : ""}`, {
    approved: true,
  });
  await chat.until(doneCount(1));

  // Grace's worker, on her credential, says it is still running Ada's turn.
  await computers.provider.stop(grace.id);
  const received: unknown[] = [];
  const socket = new WebSocket(`${url.replace("http", "ws")}/worker/${grace.id}`, {
    headers: { authorization: `Bearer ${botToken(grace.id)}` },
  });
  socket.onmessage = (event) => received.push(JSON.parse(String(event.data)));
  socket.onopen = () => socket.send(JSON.stringify({ type: "hello", activeTurnId: adaTurn }));
  await Bun.sleep(200);
  socket.close();

  expect(received.map((message) => ControlToWorker.parse(message).type)).toEqual(["bound", "screen-control"]);
});

test("a reply that did not stream still shows, sub-agent chatter stays out, and a session error ends the turn", async () => {
  const { computers, onlineBot, send, watchChat } = await setup();
  const bot = await onlineBot("Ada");
  computers.copilot.script = async function* () {
    yield sdk.delta("sub-msg", "thinking out loud", "sub-agent-1");
    yield sdk.message("msg-2", "Whole reply");
    yield sdk.error("Rate limited");
  };

  await send(bot.id, "go");

  const events = await watchChat(bot.id).until(doneCount(1));
  expect(events.map((e) => e.event)).toEqual([
    { type: "user-message", text: "go" },
    { type: "text-delta", messageId: "msg-2", text: "Whole reply" },
    { type: "error", message: "Rate limited" },
    { type: "done" },
  ]);
});
