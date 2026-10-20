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

  const locked = { lockedReason: "Needs a paid Copilot plan", efforts: [], defaultEffort: null };
  expect(await models()).toEqual([
    { id: "auto", name: "Auto", lockedReason: null, efforts: [], defaultEffort: null },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", ...locked },
    { id: "gpt-6-luna", name: "GPT-6 Luna", ...locked },
  ]);
});

// A paid plan's SDK listing: Auto, three models, one turned off by an organisation's
// policy. Two take a reasoning effort, from different levels; one lists a level
// Chiefbot does not offer ("none").
const reasoning = { supports: { vision: true, reasoningEffort: true } };
const paidModels: FakeModels = {
  list: [
    { id: "auto", name: "Auto" },
    {
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      policy: { state: "enabled", terms: "" },
      capabilities: reasoning,
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      capabilities: reasoning,
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "high",
    },
    { id: "gpt-5-mini", name: "GPT-5 mini", capabilities: { supports: { vision: false, reasoningEffort: false } } },
    { id: "o9-preview", name: "o9 (Preview)", policy: { state: "disabled", terms: "" } },
  ],
  modelPriceCategories: [{ id: "claude-sonnet-4.6" }, { id: "gpt-6.1-sol" }, { id: "gpt-5-mini" }, { id: "o9-preview" }],
};

test("on a paid plan the plan's models are selectable with their reasoning efforts, and policy-disabled ones show locked", async () => {
  const { onlineBot, models } = await setup({ sku: "monthly_subscriber", sdkModels: paidModels });
  await onlineBot("Ada");

  const noEffort = { efforts: [], defaultEffort: null };
  expect(await models()).toEqual([
    { id: "auto", name: "Auto", lockedReason: null, ...noEffort },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", lockedReason: null, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", lockedReason: null, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
    { id: "gpt-5-mini", name: "GPT-5 mini", lockedReason: null, ...noEffort },
    { id: "o9-preview", name: "o9 (Preview)", lockedReason: "Turned off by your Copilot policy", ...noEffort },
  ]);
});

test("a bot runs at the effort picked for its model; an effort the model lacks is refused, and a switch keeps it only where supported", async () => {
  const { copilot, api, onlineBot, models, turn } = await setup({ sku: "monthly_subscriber", sdkModels: paidModels });
  const ada = await onlineBot("Ada");
  await models();
  // What the bot runs on after asking for `body`, or control's refusal.
  const pick = async (body: { model: string; effort?: string | null }) => {
    const res = await api("PUT", `/bots/${ada.id}/model`, body);
    if (!res.ok) return `${res.status} ${ApiError.parse(await res.json()).error}`;
    const { model, effort } = Bot.parse(await res.json());
    return `${model} at ${effort ?? "default"}`;
  };

  const unsupported = await pick({ model: "claude-sonnet-4.6", effort: "xhigh" });
  const onAuto = await pick({ model: "auto", effort: "low" });
  const high = await pick({ model: "claude-sonnet-4.6", effort: "high" });
  await turn(ada.id, "think hard");
  // GPT-6.1 Sol supports high too, so the bot keeps it; GPT-5 mini takes no effort.
  const kept = await pick({ model: "gpt-6.1-sol" });
  await turn(ada.id, "again");
  const dropped = await pick({ model: "gpt-5-mini" });
  const backToDefault = await pick({ model: "gpt-6.1-sol", effort: null });

  expect([unsupported, onAuto, high, kept, dropped, backToDefault]).toEqual([
    "400 effort_unavailable",
    "400 effort_unavailable",
    "claude-sonnet-4.6 at high",
    "gpt-6.1-sol at high",
    "gpt-5-mini at default",
    "gpt-6.1-sol at default",
  ]);
  expect(copilot.sends.map(({ prompt, model, effort }) => [prompt, model, effort])).toEqual([
    ["think hard", "claude-sonnet-4.6", "high"],
    ["again", "gpt-6.1-sol", "high"],
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
  // Each turn resumes Ada's one session (its id is hers), so the switch kept her conversation.
  expect(new Set(copilot.sessionIds)).toEqual(new Set([ada.id, grace.id]));
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
