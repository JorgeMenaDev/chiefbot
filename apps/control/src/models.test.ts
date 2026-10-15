import { afterEach, expect, test } from "bun:test";
import { Bot, ChatEvent, ClientEvent, ModelOption, SendMessageResponse, SignInResponse, type BotId } from "@chiefbot/contracts";
import { defaultFakeUser, startFakeGitHub, type FakeGitHubUser } from "@chiefbot/fake-github";
import { fakeCopilot, type FakeModels } from "@chiefbot/worker/fake-copilot";
import { z } from "zod";
import { startControl } from "./control.ts";
import { fakeComputers } from "./computers/fakeComputers.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

// Control with a fake GitHub user on `sku`, and bot computers whose workers run a
// fake Copilot that lists `sdkModels` as the SDK would for that plan.
async function setup({ sku, sdkModels }: { sku: string; sdkModels?: FakeModels }) {
  const user: FakeGitHubUser = { ...defaultFakeUser, copilot: { plan: "individual", sku } };
  const github = startFakeGitHub({ user });
  const copilot = fakeCopilot(sdkModels ? { models: sdkModels } : {});
  const computers = fakeComputers({ copilot });
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, computers: computers.provider });
  stops.push(github.stop, computers.stopAll, control.stop);
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({ accessToken, accessTokenExpiresAt: Date.now() + 3600_000, refreshToken, refreshTokenExpiresAt: 0 }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  const headers = { authorization: `Bearer ${sessionToken}` };
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${control.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // Resolves with the bot list once it matches, failing after a second.
  const bots = (matches: (bots: Bot[]) => boolean) =>
    new Promise<Bot[]>((resolve, reject) => {
      const socket = new WebSocket(`${control.url.replace("http", "ws")}/events`, { headers });
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("bot list never matched"));
      }, 1000);
      socket.onmessage = (event) => {
        const { bots } = ClientEvent.parse(JSON.parse(String(event.data)));
        if (!matches(bots)) return;
        clearTimeout(timer);
        socket.close();
        resolve(bots);
      };
    });
  const onlineBot = async (name: string) => {
    const bot = Bot.parse(await (await api("POST", "/bots", { name })).json());
    await bots((list) => list.some(({ id, status }) => id === bot.id && status === "online"));
    return bot;
  };
  // The user's model list once a worker has reported it.
  const models = async () => {
    for (let tries = 0; tries < 50; tries++) {
      const list = z.array(ModelOption).parse(await (await api("GET", "/models")).json());
      if (list.length > 1) return list;
      await Bun.sleep(10);
    }
    throw new Error("the model list never arrived");
  };
  // Sends a message and resolves once its turn is done.
  const turn = async (botId: BotId, text: string) => {
    const res = await api("POST", `/bots/${botId}/messages`, { text });
    if (res.status !== 202) throw new Error(`send failed: ${res.status} ${await res.text()}`);
    const { turnId } = SendMessageResponse.parse(await res.json());
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${control.url.replace("http", "ws")}/bots/${botId}/chat`, { headers });
      const timer = setTimeout(() => reject(new Error("turn never finished")), 1000);
      socket.onmessage = (message) => {
        const { turnId: id, event } = ChatEvent.parse(JSON.parse(String(message.data)));
        if (id !== turnId || event.type !== "done") return;
        clearTimeout(timer);
        socket.close();
        resolve();
      };
    });
  };
  return { copilot, api, bots, onlineBot, models, turn };
}

test("on Copilot Free only Auto is selectable; the plan's other models show locked", async () => {
  const { onlineBot, models } = await setup({
    sku: "free_limited_copilot",
    // What the SDK gives on Free: no selectable models, only the catalog's price categories.
    sdkModels: {
      list: [],
      modelPriceCategories: [
        { id: "claude-sonnet-4.6" },
        { id: "gpt-6-luna" },
        { id: "gpt-4o-2024-05-13" },
      ],
    },
  });
  await onlineBot("Ada");

  expect(await models()).toEqual([
    { id: "auto", name: "Auto", lockedReason: null },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", lockedReason: "Needs a paid Copilot plan" },
    { id: "gpt-6-luna", name: "GPT-6 Luna", lockedReason: "Needs a paid Copilot plan" },
  ]);
});

// A paid plan's SDK listing: Auto, two models, one turned off by an organisation's policy.
const paidModels: FakeModels = {
  list: [
    { id: "auto", name: "Auto" },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", policy: { state: "enabled", terms: "" } },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { id: "o9-preview", name: "o9 (Preview)", policy: { state: "disabled", terms: "" } },
  ],
  modelPriceCategories: [{ id: "claude-sonnet-4.6" }, { id: "gpt-6.1-sol" }, { id: "o9-preview" }],
};

test("on a paid plan the plan's models are selectable, and policy-disabled ones show locked", async () => {
  const { onlineBot, models } = await setup({ sku: "monthly_subscriber", sdkModels: paidModels });
  await onlineBot("Ada");

  expect(await models()).toEqual([
    { id: "auto", name: "Auto", lockedReason: null },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", lockedReason: null },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", lockedReason: null },
    { id: "o9-preview", name: "o9 (Preview)", lockedReason: "Turned off by your Copilot policy" },
  ]);
});

test("each bot keeps its own model, and switching mid-conversation runs the next turn on it", async () => {
  const { copilot, api, bots, onlineBot, models, turn } = await setup({ sku: "monthly_subscriber", sdkModels: paidModels });
  const ada = await onlineBot("Ada");
  const grace = await onlineBot("Grace");
  await models();

  await turn(ada.id, "one");
  const picked = await api("PUT", `/bots/${ada.id}/model`, { model: "claude-sonnet-4.6" });
  await api("PUT", `/bots/${grace.id}/model`, { model: "gpt-6.1-sol" });
  await turn(ada.id, "two");
  await turn(grace.id, "hello");

  expect(Bot.parse(await picked.json()).model).toBe("claude-sonnet-4.6");
  expect(copilot.sends.map(({ sessionId, prompt, model }) => [sessionId, prompt, model])).toEqual([
    [ada.id, "one", "auto"],
    [ada.id, "two", "claude-sonnet-4.6"],
    [grace.id, "hello", "gpt-6.1-sol"],
  ]);
  // Ada's session was opened once: the switch kept her conversation.
  expect(copilot.sessionIds.filter((id) => id === ada.id)).toHaveLength(1);
  // The desktop's bot list shows each bot's model.
  await bots((list) => list.map(({ name, model }) => `${name}:${model}`).sort().join() === "Ada:claude-sonnet-4.6,Grace:gpt-6.1-sol");
});

test("a locked or unknown model is refused and the bot stays on its model", async () => {
  const { api, onlineBot, models } = await setup({
    sku: "free_limited_copilot",
    sdkModels: { list: [], modelPriceCategories: [{ id: "claude-sonnet-4.6" }] },
  });
  const bot = await onlineBot("Ada");
  await models();

  const locked = await api("PUT", `/bots/${bot.id}/model`, { model: "claude-sonnet-4.6" });
  const unknown = await api("PUT", `/bots/${bot.id}/model`, { model: "made-up" });

  expect([locked.status, await locked.json()]).toEqual([400, { error: "model_unavailable" }]);
  expect(unknown.status).toBe(400);
  const [after] = (await (await api("GET", "/bots")).json()) as unknown[];
  expect(Bot.parse(after).model).toBe("auto");
});
