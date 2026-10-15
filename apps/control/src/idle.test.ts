import { afterEach, expect, test } from "bun:test";
import { Bot, ChatEvent, ClientEvent, SignInResponse, type BotId } from "@chiefbot/contracts";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { fakeCopilot, sdk } from "@chiefbot/worker/fake-copilot";
import { tmpdir } from "node:os";
import { fakeClock } from "./clock.ts";
import { fakeComputers } from "./computers/fakeComputers.ts";
import { startControl } from "./control.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

const minute = 60_000;

// Control on a fake clock that stops idle bots after 30 minutes, with bot
// computers whose workers run a fake Copilot.
async function setup() {
  const github = startFakeGitHub();
  const time = fakeClock(Date.parse("2026-10-15T07:00:00Z"));
  const computers = fakeComputers({
    copilot: fakeCopilot({ shell: { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } } }),
  });
  const control = startControl({
    port: 0,
    dbPath: ":memory:",
    githubApiUrl: github.url,
    computers: computers.provider,
    clock: time.clock,
    idleStopMinutes: 30,
  });
  stops.push(github.stop, computers.stopAll, control.stop);
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({ accessToken, accessTokenExpiresAt: Date.now() + 3600_000, refreshToken, refreshTokenExpiresAt: Date.now() + 86400_000 }),
  });
  const auth = { authorization: `Bearer ${SignInResponse.parse(await signIn.json()).sessionToken}` };
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${control.url}${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const statusOf = (botId: BotId) =>
    new Promise<Bot["status"] | undefined>((resolve) => {
      const socket = new WebSocket(`${control.url.replace("http", "ws")}/events`, { headers: auth });
      socket.onmessage = (message) => {
        const event = ClientEvent.parse(JSON.parse(String(message.data)));
        if (event.type !== "bots") return;
        socket.close();
        resolve(event.bots.find((bot) => bot.id === botId)?.status);
      };
    });
  const onlineBot = async (name: string) => {
    const bot = Bot.parse(await (await api("POST", "/bots", { name })).json());
    await eventually(async () => (await statusOf(bot.id)) === "online");
    return bot;
  };
  const chat = async (botId: BotId) => {
    const events: ChatEvent[] = [];
    const socket = new WebSocket(`${control.url.replace("http", "ws")}/bots/${botId}/chat`, { headers: auth });
    socket.onmessage = (message) => events.push(ChatEvent.parse(JSON.parse(String(message.data))));
    await Bun.sleep(50);
    socket.close();
    return events.map(({ event }) => event);
  };
  return { time, computers, control, auth, api, statusOf, onlineBot, chat };
}

// Resolves once check passes, failing after two real seconds.
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await Bun.sleep(10);
  }
}

test("a bot with nothing to do is stopped after the idle limit, and not before", async () => {
  const { time, computers, statusOf, onlineBot } = await setup();
  const ada = await onlineBot("Ada");

  time.advance(29 * minute);
  await Bun.sleep(50);
  expect(await statusOf(ada.id)).toBe("online");

  time.advance(2 * minute);
  await eventually(async () => (await statusOf(ada.id)) === "stopped");
  expect(await computers.provider.status(ada.id)).toBe("stopped");
});

test("a turn waiting on an approval and a screen viewer keep their bots running; once both end, the bots stop", async () => {
  const { time, computers, control, auth, api, statusOf, onlineBot, chat } = await setup();
  computers.copilot.script = async function* (_prompt, runtime) {
    await runtime.shell("git push origin main");
    yield sdk.idle();
  };
  const ada = await onlineBot("Ada");
  const grace = await onlineBot("Grace");
  await api("POST", `/bots/${ada.id}/messages`, { text: "push it" });
  await eventually(async () => (await chat(ada.id)).some((event) => event.type === "approval-request"));
  const viewer = new WebSocket(`${control.url.replace("http", "ws")}/bots/${grace.id}/screen`, { headers: auth });
  await new Promise((resolve) => (viewer.onmessage = resolve));

  time.advance(3 * 60 * minute);
  await Bun.sleep(50);
  expect([await statusOf(ada.id), await statusOf(grace.id)]).toEqual(["online", "online"]);

  const request = (await chat(ada.id)).find((event) => event.type === "approval-request");
  await api("POST", `/bots/${ada.id}/approvals/${request?.type === "approval-request" ? request.approvalId : ""}`, { approved: false });
  await eventually(async () => (await chat(ada.id)).at(-1)?.type === "done");
  viewer.close();
  await Bun.sleep(50);
  time.advance(29 * minute);
  await Bun.sleep(50);
  expect([await statusOf(ada.id), await statusOf(grace.id)]).toEqual(["online", "online"]);

  time.advance(2 * minute);
  await eventually(async () => (await statusOf(ada.id)) === "stopped" && (await statusOf(grace.id)) === "stopped");
});
