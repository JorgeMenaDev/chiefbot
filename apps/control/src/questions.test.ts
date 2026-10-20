import { afterEach, expect, test } from "bun:test";
import { ApiError, ControlToWorker, type ChatEvent, type QuestionId, type QuestionResult, type TurnId } from "@chiefbot/contracts";
import { sdk, type FakeRuntime } from "@chiefbot/worker/fake-copilot";
import { cleanUp, doneCount, eventually, startTestControl } from "./testControl.ts";

afterEach(cleanUp);

// A form with one question of each kind, as Copilot's ask_user tool sends it.
const form: Parameters<FakeRuntime["ask"]>[1] = {
  type: "object",
  properties: {
    language: { type: "string", title: "Language", enum: ["ts", "go"], enumNames: ["TypeScript", "Go"] },
    checks: { type: "array", title: "Checks", items: { type: "string", enum: ["tests", "lint"] } },
    name: { type: "string", title: "Name" },
  },
};

// The user's answer to `form`, and the content the agent gets for it.
const accepted = { action: "accept", answers: ["ts — strict, please", ["tests", "lint", "and a smoke run"], "Atlas"] } satisfies QuestionResult;
const received: Awaited<ReturnType<FakeRuntime["ask"]>> = {
  action: "accept",
  content: { language: "ts — strict, please", checks: ["tests", "lint", "and a smoke run"], name: "Atlas" },
};

// Control and an online bot whose agent asks `asks` (default: form) and keeps
// each answer it gets. While it waits, `then` runs with the runtime and the
// turn may end with `ending` (default: done).
async function setup({
  persistent = false,
  asks = form,
  then,
  ending = sdk.idle(),
}: { persistent?: boolean; asks?: typeof form; then?: (runtime: FakeRuntime) => Promise<void>; ending?: ReturnType<typeof sdk.idle> } = {}) {
  const control = await startTestControl({ persistent });
  const answers: Array<Awaited<ReturnType<FakeRuntime["ask"]>>> = [];
  control.computers.copilot.script = async function* (_prompt, runtime) {
    const answer = runtime.ask("Before I start", asks);
    await then?.(runtime);
    if (ending.type === "session.idle") answers.push(await answer);
    yield ending;
  };
  const bot = await control.user.onlineBot("Ada");
  const chat = control.user.watchChat(bot.id);
  // Sends a message; resolves with its turn and the question it asks.
  const ask = async () => {
    const turnId = await control.user.send(bot.id, "start");
    const asked = (await chat.until((events) => events.some(isQuestionOf(turnId)))).find(isQuestionOf(turnId));
    if (asked?.event.type !== "question-request") throw new Error("no question");
    return { turnId, ...asked.event };
  };
  const answer = (questionId: QuestionId, body: unknown, api = control.user.api) => api("POST", `/bots/${bot.id}/questions/${questionId}`, body);
  // The types of a turn's events so far.
  const typesOf = (turnId: TurnId) => chat.events.filter((e) => e.turnId === turnId).map((e) => e.event.type);
  return { ...control, ...control.user, bot, chat, answers, ask, answer, typesOf };
}

const isQuestionOf = (turnId: string) => (e: ChatEvent) => e.turnId === turnId && e.event.type === "question-request";

// A promise the test resolves with release().
function gate() {
  let release = () => {};
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { opened, release };
}

test("the agent's form becomes a question card; the answer reaches it as the form's content, and Don't answer declines", async () => {
  const { chat, answers, ask, answer } = await setup();

  const request = await ask();
  expect(request.form).toEqual({
    message: "Before I start",
    questions: [
      { key: "language", title: "Language", description: "", kind: "single", type: "string", options: [{ value: "ts", label: "TypeScript" }, { value: "go", label: "Go" }] },
      { key: "checks", title: "Checks", description: "", kind: "multi", type: "string", options: [{ value: "tests", label: "tests" }, { value: "lint", label: "lint" }] },
      { key: "name", title: "Name", description: "", kind: "text", type: "string", options: [] },
    ],
  });
  expect((await answer(request.questionId, accepted)).status).toBe(204);
  await chat.until(doneCount(1));
  const declined = await ask();
  expect((await answer(declined.questionId, { action: "decline" })).status).toBe(204);
  await chat.until(doneCount(2));

  expect(answers).toEqual([received, { action: "decline" }]);
  expect(chat.events.filter((e) => e.event.type === "question-answer").map((e) => e.event)).toEqual([
    { type: "question-answer", questionId: request.questionId, result: accepted },
    { type: "question-answer", questionId: declined.questionId, result: { action: "decline" } },
  ]);
});

test("control checks each answer: 400 when it does not fit the form, 404 from another user, 409 once answered", async () => {
  const { signIn, answers, ask, answer, chat } = await setup();
  const { questionId } = await ask();
  const stranger = await signIn({ id: 6161, login: "octo-stranger", copilot: null });
  const misfits = [
    { action: "accept", answers: ["ts", ["tests"]] },
    { action: "accept", answers: ["ts", "tests", "Atlas"] },
    { action: "accept", answers: ["ts", ["tests"], "  "] },
    { action: "accept", answers: [...accepted.answers, "blue"] },
    { action: "cancel" },
  ];

  const refused = await Promise.all(misfits.map(async (body) => (await answer(questionId, body)).status));
  const wrongUser = await answer(questionId, accepted, stranger.api);
  const first = await answer(questionId, accepted);
  const second = await answer(questionId, { action: "decline" });
  await chat.until(doneCount(1));

  expect(refused).toEqual([400, 400, 400, 400, 400]);
  expect(wrongUser.status).toBe(404);
  expect(first.status).toBe(204);
  expect([second.status, ApiError.parse(await second.json())]).toEqual([409, { error: "not_pending" }]);
  expect(answers).toEqual([received]);
});

test("any schema key works, even __proto__, and a number or yes/no reaches the agent typed unless the user typed their own", async () => {
  // Object.fromEntries, as JSON.parse would: `__proto__` is the schema's own key.
  const odd: typeof form = {
    type: "object",
    properties: Object.fromEntries([
      ["__proto__", { type: "string", title: "Name" }],
      ["constructor", { type: "integer", title: "Replicas" }],
      ["public", { type: "boolean", title: "Public?" }],
    ] as const),
  };
  const { chat, answers, ask, answer } = await setup({ asks: odd });

  const typed = await ask();
  const misfit = await answer(typed.questionId, { action: "accept", answers: ["Atlas", 2.5, false] });
  const ok = await answer(typed.questionId, { action: "accept", answers: ["Atlas", 3, false] });
  await chat.until(doneCount(1));
  const own = await ask();
  expect((await answer(own.questionId, { action: "accept", answers: ["Atlas", "three or four", "only on Fridays"] })).status).toBe(204);
  await chat.until(doneCount(2));

  expect(typed.form.questions.map(({ key, kind, type }) => ({ key, kind, type }))).toEqual([
    { key: "__proto__", kind: "text", type: "string" },
    { key: "constructor", kind: "text", type: "integer" },
    { key: "public", kind: "single", type: "boolean" },
  ]);
  expect([misfit.status, ok.status]).toEqual([400, 204]);
  expect(answers.map((got) => JSON.stringify(got))).toEqual([
    '{"action":"accept","content":{"__proto__":"Atlas","constructor":3,"public":false}}',
    '{"action":"accept","content":{"__proto__":"Atlas","constructor":"three or four","public":"only on Fridays"}}',
  ]);
});

test("a question still pending when control restarts can be answered after, and the answer reaches the agent", async () => {
  const { stopControl, startControl, watchChat, bot, answers, ask, answer } = await setup({ persistent: true });
  const { questionId } = await ask();

  stopControl();
  startControl();

  expect((await answer(questionId, accepted)).status).toBe(204);
  await watchChat(bot.id).until(doneCount(1));
  expect(answers).toEqual([received]);
});

test("a worker that reconnects mid-turn is sent the answers it missed", async () => {
  const { url, computers, bot, botToken, ask, answer } = await setup();
  const { turnId, questionId } = await ask();
  // The worker drops off, and the answer is stored meanwhile.
  await computers.provider.stop(bot.id);
  expect((await answer(questionId, accepted)).status).toBe(204);

  // A worker on the bot's credential says it still runs that turn.
  const received: ControlToWorker[] = [];
  const socket = new WebSocket(`${url.replace("http", "ws")}/worker/${bot.id}`, { headers: { authorization: `Bearer ${botToken(bot.id)}` } });
  socket.onmessage = (event) => received.push(ControlToWorker.parse(JSON.parse(String(event.data))));
  socket.onopen = () => socket.send(JSON.stringify({ type: "hello", activeTurnId: turnId }));
  await eventually(() => received.some((message) => message.type === "question-answer"));
  socket.close();

  expect(received.filter((message) => message.type === "question-answer")).toEqual([{ type: "question-answer", questionId, result: accepted }]);
});

test("the card is withdrawn once the SDK resolves its request without the answer, and can no longer be answered", async () => {
  const resolved = gate();
  const { chat, answers, ask, answer, typesOf } = await setup({
    then: async (runtime) => {
      await resolved.opened;
      runtime.resolveQuestion("question-1");
    },
  });
  const { turnId, questionId } = await ask();

  resolved.release();
  await chat.until(doneCount(1));

  expect(typesOf(turnId)).toEqual(["user-message", "question-request", "question-withdrawn", "done"]);
  expect(answers).toEqual([{ action: "cancel" }]);
  expect((await answer(questionId, accepted)).status).toBe(409);
});

test("a question still pending when its turn ends is withdrawn just before the done", async () => {
  const failed = gate();
  const { chat, ask, answer, typesOf } = await setup({ then: () => failed.opened, ending: sdk.error("The model gave up.") });
  const { turnId, questionId } = await ask();

  failed.release();
  await chat.until(doneCount(1));

  expect(typesOf(turnId)).toEqual(["user-message", "question-request", "error", "question-withdrawn", "done"]);
  expect((await answer(questionId, accepted)).status).toBe(409);
});

test("stopping the bot withdraws its pending question", async () => {
  const { api, bot, chat, ask, answer, typesOf } = await setup();
  const { turnId, questionId } = await ask();

  await api("POST", `/bots/${bot.id}/stop`);
  await chat.until(doneCount(1));

  expect(typesOf(turnId)).toEqual(["user-message", "question-request", "question-withdrawn", "error", "done"]);
  expect((await answer(questionId, accepted)).status).toBe(409);
});

test("a worker restart leaves the question to expire: its turn ends without withdrawing it, and it can no longer be answered", async () => {
  const { computers, bot, chat, ask, answer, typesOf } = await setup();
  const { turnId, questionId } = await ask();

  await computers.provider.stop(bot.id);
  await computers.provider.start(bot.id);
  await chat.until(doneCount(1));

  expect(typesOf(turnId)).toEqual(["user-message", "question-request", "error", "done"]);
  expect((await answer(questionId, accepted)).status).toBe(409);
});
