import { afterEach, expect, test } from "bun:test";
import {
  ApprovalId,
  Bot,
  BotId,
  ClientEvent,
  HandoffId,
  ProjectId,
  QuestionId,
  SignInResponse,
  TurnId,
  WorkspaceId,
  type ChatEvent,
  type ChatView,
  type HandoffCard,
  type QuestionForm,
} from "@chiefbot/contracts";
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
  const control = startControl({ port: 0, dbPath, githubApiUrl: github.url, githubClientId: "test-client", githubApp: github.app, computers: computers.provider });
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
    const restarted = startControl({ port: Number(new URL(control.url).port), dbPath, githubApiUrl: github.url, githubClientId: "test-client", githubApp: github.app, computers: computers.provider });
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

test("a picture sent with a message shows with it, and reads back as an image for its thumbnail", async () => {
  const { control, sessionToken, botId } = await setup();
  const desktop = launch(control.url, sessionToken);
  desktop.chats.open(botId);
  // A PNG's first 8 bytes.
  const png = "iVBORw0KGgo=";

  await desktop.chats.send(botId, "look", [{ name: "dot.png", mimeType: "image/png", data: png }]);
  const [sent] = (await desktop.until(botId, idleWith(3))).items;

  expect(sent).toMatchObject({ kind: "user", text: "look", attachments: [{ name: "dot.png", mimeType: "image/png", size: 8 }] });
  const id = sent?.kind === "user" ? sent.attachments?.[0]?.id : undefined;
  expect(id && (await desktop.chats.attachment(botId, id))).toBe(`data:image/png;base64,${png}`);
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

test("a risky tool call shows as a pending approval card, still pending after a relaunch, and answering it lets the bot go on", async () => {
  const { control, computers, sessionToken, botId } = await setup();
  computers.copilot.script = async function* (_prompt, runtime) {
    await runtime.mcp("github", "Merge pull request", false);
    yield sdk.idle();
  };
  const desktop = launch(control.url, sessionToken);
  desktop.chats.open(botId);
  await desktop.chats.send(botId, "merge it");
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
    request: "tool",
    detail: "github: Merge pull request",
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
    { type: "user-message", text: "merge it" },
    { type: "approval-request", approvalId, kind: "push", detail: "git push to octo/demo: main" },
    { type: "error", message: "The bot restarted before it finished this message." },
    { type: "done" },
  ] as const;

  const empty: ChatView = { botId: BotId.parse("bot-1"), items: [], working: null };
  const view = events.reduce<ChatView>((view, event, seq) => foldChat(view, { seq, turnId, event }), empty);

  expect(view.items.find((item) => item.kind === "approval")).toMatchObject({ state: "expired" });
});

test("a handoff's cards fold into one card, where it first appeared, that shows the latest", () => {
  const ask = TurnId.parse("turn-1");
  const later = TurnId.parse("turn-3");
  const card: HandoffCard = {
    handoffId: HandoffId.parse("handoff-1"),
    workspaceId: WorkspaceId.parse("workspace-1"),
    projectId: ProjectId.parse("project-1"),
    project: "shop",
    title: "Checkout",
    taskNumber: 1,
    stage: "accepted",
    question: null,
    pullRequests: [],
    verification: null,
  };
  const pullRequest = "https://github.com/octo-org/shop/pull/7";
  const empty: ChatView = { botId: BotId.parse("bot-1"), items: [], working: null };
  const events: ChatEvent[] = [
    { seq: 1, turnId: ask, event: { type: "user-message", text: "hand the checkout over" } },
    { seq: 2, turnId: ask, event: { type: "tool-call", toolCallId: "t1", name: "send_to_project", status: "running" } },
    { seq: 3, turnId: TurnId.parse("turn-2"), event: { type: "handoff-card", card } },
    { seq: 4, turnId: ask, event: { type: "tool-call", toolCallId: "t1", name: "send_to_project", status: "succeeded" } },
    { seq: 5, turnId: ask, event: { type: "text-delta", messageId: "m1", text: "Sent." } },
    { seq: 6, turnId: ask, event: { type: "done" } },
    { seq: 7, turnId: later, event: { type: "user-message", text: "thanks" } },
    { seq: 8, turnId: later, event: { type: "done" } },
    { seq: 9, turnId: TurnId.parse("turn-4"), event: { type: "handoff-card", card: { ...card, stage: "needs_input", question: "Stripe or Adyen?" } } },
    { seq: 10, turnId: TurnId.parse("turn-5"), event: { type: "handoff-card", card: { ...card, stage: "pr_opened", pullRequests: [pullRequest] } } },
  ];

  const view = events.reduce<ChatView>(foldChat, empty);

  expect(view.items.map(({ kind }) => kind)).toEqual(["user", "tool", "handoff", "assistant", "user"]);
  expect(view.items[2]).toEqual({ kind: "handoff", id: "handoff:handoff-1", ...card, stage: "pr_opened", pullRequests: [pullRequest] });
  expect(view.working).toBeNull();
});

test("a bot's question shows as a card, still pending after a relaunch, and answering it lets the bot go on", async () => {
  const { control, computers, sessionToken, botId } = await setup();
  const answers: unknown[] = [];
  computers.copilot.script = async function* (_prompt, runtime) {
    answers.push(await runtime.ask("Which one?", { type: "object", properties: { pick: { type: "string", enum: ["a", "b"] } } }));
    yield sdk.idle();
  };
  const desktop = launch(control.url, sessionToken);
  desktop.chats.open(botId);
  await desktop.chats.send(botId, "choose");
  await desktop.until(botId, (view) => view.items.some((item) => item.kind === "question"));
  desktop.chats.disconnect();

  const relaunched = launch(control.url, sessionToken);
  relaunched.chats.open(botId);
  const pending = await relaunched.until(botId, (view) => view.items.some((item) => item.kind === "question"));
  const card = pending.items.find((item) => item.kind === "question");
  expect(card).toEqual({
    kind: "question",
    id: expect.any(String),
    questionId: expect.any(String),
    form: { message: "Which one?", questions: [{ key: "pick", title: "pick", description: "", kind: "single", type: "string", options: [{ value: "a", label: "a" }, { value: "b", label: "b" }] }] },
    state: "pending",
  });
  expect(pending.working).toBe("Waiting for your answer");

  const result = { action: "accept" as const, answers: ["b"] };
  await relaunched.chats.answerQuestion(botId, QuestionId.parse(card?.kind === "question" ? card.questionId : ""), result);
  const view = await relaunched.until(botId, (view) => view.working === null);
  expect(view.items.find((item) => item.kind === "question")).toMatchObject({ state: "answered", answer: result });
  expect(answers).toEqual([{ action: "accept", content: { pick: "b" } }]);
});

test("a question settles once, answered or withdrawn; one still pending when its turn ends expires", () => {
  const form: QuestionForm = { message: "Name?", questions: [{ key: "name", title: "Name", description: "", kind: "text", type: "string", options: [] }] };
  const asked = (turn: string, question: string): ChatEvent[] => [
    { seq: 0, turnId: TurnId.parse(turn), event: { type: "user-message", text: "go" } },
    { seq: 0, turnId: TurnId.parse(turn), event: { type: "question-request", questionId: QuestionId.parse(question), form } },
  ];
  const answer = { action: "accept" as const, answers: ["Atlas"] };
  const events: ChatEvent[] = [
    ...asked("turn-1", "answered"),
    { seq: 0, turnId: TurnId.parse("turn-1"), event: { type: "question-answer", questionId: QuestionId.parse("answered"), result: answer } },
    // The worker withdrew it as the answer came in: the answer stands.
    { seq: 0, turnId: TurnId.parse("turn-1"), event: { type: "question-withdrawn", questionId: QuestionId.parse("answered") } },
    { seq: 0, turnId: TurnId.parse("turn-1"), event: { type: "done" } },
    ...asked("turn-2", "withdrawn"),
    { seq: 0, turnId: TurnId.parse("turn-2"), event: { type: "question-withdrawn", questionId: QuestionId.parse("withdrawn") } },
    { seq: 0, turnId: TurnId.parse("turn-2"), event: { type: "done" } },
    ...asked("turn-3", "expired"),
    { seq: 0, turnId: TurnId.parse("turn-3"), event: { type: "error", message: "The bot restarted before it finished this message." } },
    { seq: 0, turnId: TurnId.parse("turn-3"), event: { type: "done" } },
  ];

  const empty: ChatView = { botId: BotId.parse("bot-1"), items: [], working: null };
  const view = events.reduce<ChatView>(foldChat, empty);

  expect(view.items.flatMap((item) => (item.kind === "question" ? [[item.questionId, item.state, item.answer]] : []))).toEqual([
    ["answered", "answered", answer],
    ["withdrawn", "withdrawn", undefined],
    ["expired", "expired", undefined],
  ]);
});

test("the bot waits for your answer while any of its questions is still pending, whatever status the turn reports", () => {
  const turnId = TurnId.parse("turn-1");
  const form: QuestionForm = { message: "Name?", questions: [{ key: "name", title: "Name", description: "", kind: "text", type: "string", options: [] }] };
  const steps: ChatEvent["event"][] = [
    { type: "user-message", text: "go" },
    { type: "status", text: "Planning" },
    { type: "question-request", questionId: QuestionId.parse("first"), form },
    { type: "status", text: "Reading files" },
    { type: "question-request", questionId: QuestionId.parse("second"), form },
    { type: "question-answer", questionId: QuestionId.parse("first"), result: { action: "decline" } },
    { type: "question-withdrawn", questionId: QuestionId.parse("second") },
    { type: "status", text: "Scaffolding" },
  ];

  const empty: ChatView = { botId: BotId.parse("bot-1"), items: [], working: null };
  const views = steps.reduce<ChatView[]>((views, event, seq) => [...views, foldChat(views.at(-1) ?? empty, { seq, turnId, event })], []);

  expect(views.map((view) => view.working)).toEqual([
    "",
    "Planning",
    "Waiting for your answer",
    "Waiting for your answer",
    "Waiting for your answer",
    "Waiting for your answer",
    "",
    "Scaffolding",
  ]);
});

test("a handoff notice from before cards shows in the chief's chat as a notice, even in the middle of a reply", () => {
  const reply = TurnId.parse("turn-1");
  const notice = TurnId.parse("turn-2");
  const empty: ChatView = { botId: BotId.parse("bot-1"), items: [], working: null };
  const events: ChatEvent[] = [
    { seq: 1, turnId: reply, event: { type: "user-message", text: "what's next?" } },
    { seq: 2, turnId: reply, event: { type: "text-delta", messageId: "m1", text: "Let me " } },
    {
      seq: 3,
      turnId: notice,
      event: { type: "handoff-update", handoffId: HandoffId.parse("handoff-1"), status: "done", text: 'shop finished "Checkout" (task #1).' },
    },
    { seq: 4, turnId: reply, event: { type: "text-delta", messageId: "m1", text: "check." } },
  ];

  const view = events.reduce<ChatView>(foldChat, empty);

  expect(view.items.map((item) => [item.kind, "text" in item ? item.text : ""])).toEqual([
    ["user", "what's next?"],
    ["assistant", "Let me check."],
    ["notice", 'shop finished "Checkout" (task #1).'],
  ]);
  expect(view.working).toBe("");
});

test("a turn control queued in a project chat shows as a notice, not as the member's message, and leaves the composer free", () => {
  const empty: ChatView = { botId: BotId.parse("bot-1"), items: [], working: null };
  const text = "Engineer for task #1 ended: opened a pull request.";

  const view = foldChat(empty, { seq: 1, turnId: TurnId.parse("turn-1"), event: { type: "system-message", text } });

  expect(view.items).toEqual([{ kind: "notice", id: "turn-1", text }]);
  expect(view.working).toBeNull();
});
