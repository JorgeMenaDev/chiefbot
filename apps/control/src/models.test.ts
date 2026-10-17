import { afterEach, expect, test } from "bun:test";
import { ApiError, Bot, ModelOption, type BotId } from "@chiefbot/contracts";
import { defaultFakeUser } from "@chiefbot/fake-github";
import { fakeCopilot, type FakeModels } from "@chiefbot/worker/fake-copilot";
import { z } from "zod";
import { cleanUp, startTestControl } from "./testControl.ts";

afterEach(cleanUp);

// Control with a fake GitHub user on `sku`, and bot computers whose workers run a
// fake Copilot that lists `sdkModels` as the SDK would for that plan.
async function setup({ sku, sdkModels }: { sku: string; sdkModels?: FakeModels }) {
  const { copilot, user } = await startTestControl({
    user: { ...defaultFakeUser, copilot: { plan: "individual", sku } },
    copilot: fakeCopilot(sdkModels ? { models: sdkModels } : {}),
  });
  const { api } = user;
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
    const turnId = await user.send(botId, text);
    await user.watchChat(botId).until((events) => events.some((e) => e.turnId === turnId && e.event.type === "done"));
  };
  return { copilot, api, bots: (matches: (bots: Bot[]) => boolean) => user.watchBots().until(matches), onlineBot: user.onlineBot, models, turn };
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

  expect([locked.status, ApiError.parse(await locked.json())]).toEqual([400, { error: "model_unavailable" }]);
  expect(unknown.status).toBe(400);
  const [after] = Bot.array().parse(await (await api("GET", "/bots")).json());
  expect(after?.model).toBe("auto");
});
