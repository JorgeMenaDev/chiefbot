import type { ServerWebSocket } from "bun";
import {
  AnswerApprovalRequest,
  ApprovalId,
  AUTO_MODEL,
  BotToken,
  CreateBotRequest,
  defaultGitHubClientId,
  GitHubTokens,
  RoutineInput,
  SendMessageRequest,
  SessionToken,
  SetBotModelRequest,
  WorkerToControl,
  type Bot,
  type ApiError,
  type ApiErrorCode,
  type BotId,
  type ChatEvent,
  type ClientEvent,
  type ControlToWorker,
  type ModelOption,
  type ScreenControl,
  type SendMessageResponse,
  type SignInResponse,
  type TurnId,
  type TurnRefusal,
  type User,
  type UserId,
} from "@chiefbot/contracts";
import { systemClock, type Clock } from "./clock.ts";
import type { ComputerProvider } from "./computers/computer.ts";
import { fetchIdentity, GitHubAuthError, refreshGitHubTokens } from "./github.ts";
import { startIdleStop } from "./idle.ts";
import { modelOptions } from "./models.ts";
import { startScheduler } from "./routines.ts";
import { nextDueAt } from "./schedule.ts";
import { localSecretStore, type SecretStore } from "./secrets/secretStore.ts";
import { openStore } from "./store.ts";
import { tokenBroker } from "./tokens.ts";

export type ControlOptions = {
  port: number;
  // Interface to listen on. Default 127.0.0.1.
  hostname?: string;
  dbPath: string;
  // api.github.com in production; a fake in tests.
  githubApiUrl: string;
  // github.com, for the refresh grant. Defaults to githubApiUrl: the fake serves both.
  githubUrl?: string;
  // The OAuth App the desktop signs in with. Refreshes must use the same one.
  githubClientId?: string;
  // Where users' refresh tokens live. Defaults to an encrypted store in dbPath
  // whose key lasts only this process: fine for tests; index.ts passes a lasting one.
  secrets?: SecretStore;
  // Where bot computers run: Docker locally, a fake in tests.
  computers: ComputerProvider;
  // Control's URL as a bot computer reaches it. Defaults to the URL control listens on.
  workerControlUrl?: string;
  // When routines are due and bots count as idle. A fake in tests.
  clock?: Clock;
  // A running bot's computer stops after this long with no running turn, no
  // pending approval, no screen viewer and no routine run in progress. Default 30.
  idleStopMinutes?: number;
};

// What a WebSocket connection is bound to: a desktop client of one user, one
// bot's chat from `after` on, the worker of exactly one bot, or one end of a
// screen stream: the owner's viewer, or the bot's worker piping its VNC server.
type SocketData =
  | { kind: "client"; userId: UserId }
  | { kind: "chat"; botId: BotId; after: number }
  | { kind: "worker"; userId: UserId; botId: BotId }
  | { kind: "viewer"; botId: BotId; streamId: string }
  | { kind: "screen"; streamId: string };

// One viewer watching one bot's screen. Viewer frames sent before the worker
// joins wait in `queued`.
type ScreenStream = {
  botId: BotId;
  viewer: ServerWebSocket<SocketData>;
  screen: ServerWebSocket<SocketData> | null;
  queued: Array<string | Buffer>;
};

// The control plane's HTTP + WebSocket server.
//   POST   /sessions          body GitHubTokens → SignInResponse
//   GET    /me                bearer session    → User
//   DELETE /sessions/current  bearer session    → 204
//   DELETE /me/github         bearer session    → 204; forgets the user's GitHub sign-in, so their
//                             bots get no token until they sign in again
//   GET    /bots              bearer session    → Bot[]
//   POST   /bots              bearer session, body CreateBotRequest → 201 Bot (its computer is starting)
//   POST   /bots/:id/start    bearer session    → Bot
//   POST   /bots/:id/stop     bearer session    → Bot
//   POST   /bots/:id/take-over bearer session   → Bot (the human drives the screen; agent input waits)
//   POST   /bots/:id/hand-back bearer session   → Bot (the agent drives the screen again)
//   WS     /bots/:id/screen   bearer session    ↔ the screen's RFB bytes (noVNC speaks it); 409 while offline
//   DELETE /bots/:id          bearer session, ?deleteData=true also deletes its disk → 204
//   PUT    /bots/:id/model    bearer session, body SetBotModelRequest → Bot; the bot's next turn runs on it
//                             (400 model_unavailable when the user's plan does not offer it or it is locked)
//   POST   /bots/:id/messages bearer session, body SendMessageRequest → 202 SendMessageResponse
//                             (409 when the bot is not online, is still on a turn or the human has its screen)
//   GET    /models            bearer session    → ModelOption[]: the picker rows for the user's Copilot plan
//   POST   /bots/:id/approvals/:approvalId  bearer session, body AnswerApprovalRequest → 204
//                             (409 when it is not pending: answered, unknown, or its turn ended)
//   GET    /bots/:id/routines bearer session    → Routine[]
//   POST   /bots/:id/routines bearer session, body RoutineInput → 201 Routine (400 invalid_schedule)
//   PUT    /bots/:id/routines/:routineId  bearer session, body RoutineInput → Routine
//   DELETE /bots/:id/routines/:routineId  bearer session → 204
//   WS     /events            bearer session    → ClientEvent on connect and on every change
//   WS     /bots/:id/chat     bearer session, ?after=<seq> → each ChatEvent after seq, then live ones
//   WS     /worker/:botId     bearer bot token of that bot → ControlToWorker; WorkerToControl back
//                             (403 for another bot's)
//   GET    /worker/:botId/github-token  bearer bot token of that bot → BrokeredGitHubToken
//                             (403 BrokerRefusal when the owner must sign in again)
//   WS     /worker/:botId/screen/:streamId  same token ↔ the VNC bytes for one viewer, after screen-open
//
// Every error body is an ApiError (packages/contracts errors.ts).
//
// The screen never listens beyond the computer's loopback: for each viewer,
// control asks the worker to dial back and pipe x11vnc, and joins the two sockets.
export function startControl({
  port,
  hostname = "127.0.0.1",
  dbPath,
  githubApiUrl,
  githubUrl = githubApiUrl,
  githubClientId = defaultGitHubClientId,
  secrets = localSecretStore({ dbPath, key: crypto.getRandomValues(new Uint8Array(32)) }),
  computers,
  workerControlUrl,
  clock = systemClock,
  idleStopMinutes = 30,
}: ControlOptions) {
  const store = openStore(dbPath);
  const broker = tokenBroker({
    store,
    secrets,
    refresh: (refreshToken) => refreshGitHubTokens(githubUrl, githubClientId, refreshToken),
    onChange: (userId) =>
      server.publish(topic(userId), JSON.stringify({ type: "user", user: store.user(userId) } satisfies ClientEvent)),
  });
  // The connected worker of each bot. A bot is online while it has one.
  const workers = new Map<BotId, ServerWebSocket<SocketData>>();
  // Bots whose connected worker has said hello, so it may be sent a turn. Who
  // waits for that, and who waits for a turn to end (with its error, if any).
  const greeted = new Set<BotId>();
  const onlineWaiters = new Map<BotId, Set<() => void>>();
  const turnWatchers = new Map<TurnId, { error: string | null; done: (error: string | null) => void }>();
  // Who drives each bot's screen; absent means the agent. Kept in memory, so a
  // control restart hands every screen back to the agent.
  const screenControl = new Map<BotId, ScreenControl>();
  const screenStreams = new Map<string, ScreenStream>();

  // Closes both ends of a screen stream.
  function endStream(streamId: string) {
    const stream = screenStreams.get(streamId);
    if (stream) idle.touch(stream.botId);
    screenStreams.delete(streamId);
    stream?.viewer.close();
    stream?.screen?.close();
  }

  const botsOf = (userId: UserId): Bot[] =>
    store.botsFor(userId).map(({ id, name, running, model }) => ({
      id,
      name,
      status: !running ? "stopped" : workers.has(id) ? "online" : "starting",
      model,
      screenControl: screenControl.get(id) ?? "agent",
    }));
  const botOf = (userId: UserId, botId: BotId) => botsOf(userId).find((bot) => bot.id === botId);
  const modelOptionsOf = (user: User): ModelOption[] => modelOptions(store.modelReport(user.id), user.copilotPlan);
  const topic = (userId: UserId) => `bots:${userId}`;
  const botsEvent = (userId: UserId) => JSON.stringify({ type: "bots", bots: botsOf(userId) } satisfies ClientEvent);
  const publish = (userId: UserId) => server.publish(topic(userId), botsEvent(userId));
  const screenControlMessage = (botId: BotId) =>
    JSON.stringify({ type: "screen-control", control: screenControl.get(botId) ?? "agent" } satisfies ControlToWorker);

  // Take-over and hand-back: tell the bot's worker and the owner's clients.
  function setScreenControl(user: User, botId: BotId, control: ScreenControl) {
    screenControl.set(botId, control);
    workers.get(botId)?.send(screenControlMessage(botId));
    publish(user.id);
    return Response.json(botOf(user.id, botId));
  }
  const chatTopic = (botId: BotId) => `chat:${botId}`;
  // Every stored chat event passes here.
  const publishChat = (botId: BotId, event: ChatEvent | null) => {
    if (!event) return;
    idle.touch(botId);
    server.publish(chatTopic(botId), JSON.stringify(event satisfies ChatEvent));
    const watcher = turnWatchers.get(event.turnId);
    if (watcher && event.event.type === "error") watcher.error = event.event.message;
    if (watcher && event.event.type === "done") {
      turnWatchers.delete(event.turnId);
      watcher.done(watcher.error);
    }
  };

  const setRunning = async (userId: UserId, botId: BotId, running: boolean) => {
    await (running ? computers.start(botId) : computers.stop(botId));
    store.setRunning(botId, running);
    publish(userId);
  };

  // Starts a chat turn with `text` on the bot's worker: a user's message or a routine's prompt.
  const sendTurn = (
    userId: UserId,
    botId: BotId,
    text: string,
  ): { turnId: TurnId } | { error: TurnRefusal } => {
    const worker = workers.get(botId);
    if (!worker) return { error: "bot_offline" };
    if (store.unfinishedTurns(botId).length > 0) return { error: "turn_running" };
    // The agent waits while the human drives the screen. A turn already running
    // pauses at its next tool call (the worker holds it until hand-back).
    if (screenControl.get(botId) === "human") return { error: "human_has_screen" };
    const model = store.botFor(userId, botId)?.model ?? AUTO_MODEL;
    const started = store.startTurn(botId, text);
    publishChat(botId, started);
    worker.send(JSON.stringify({ type: "run-turn", turnId: started.turnId, text, model } satisfies ControlToWorker));
    return { turnId: started.turnId };
  };

  // The bot's routine with a schedule control can run, or a 400.
  const scheduled = async (req: Request) => {
    const body = RoutineInput.safeParse(await req.json().catch(() => null));
    if (!body.success) return apiError(400, "invalid_routine");
    try {
      const next = nextDueAt(body.data.cron, body.data.timezone, clock.now());
      if (next !== null) return { input: body.data, nextDueAt: next };
    } catch {}
    return apiError(400, "invalid_schedule");
  };

  // Runs a worker route for the bot whose credential it carries; 401 or 403 otherwise.
  const ownWorker = (
    req:
      | Bun.BunRequest<"/worker/:botId">
      | Bun.BunRequest<"/worker/:botId/github-token">
      | Bun.BunRequest<"/worker/:botId/screen/:streamId">,
  ) => {
    const bot = store.botForToken(bearer(req));
    if (!bot) return unauthorized();
    if (bot.botId !== req.params.botId) return apiError(403, "wrong_bot");
    return bot;
  };

  // Runs a bot route for the signed-in owner of :id; 401 or 404 otherwise.
  const ownBot =
    <Req extends Request & { params: { id: string } }>(
      handle: (
        user: User,
        botId: BotId,
        req: Req,
        server: Bun.Server<SocketData>,
      ) => Response | undefined | Promise<Response | undefined>,
    ) =>
    (req: Req, server: Bun.Server<SocketData>) => {
      const user = store.userForSession(bearer(req));
      if (!user) return unauthorized();
      const bot = store.botFor(user.id, req.params.id);
      if (!bot) return apiError(404, "not_found");
      return handle(user, bot.id, req, server);
    };

  const server = Bun.serve({
    port,
    hostname,
    routes: {
      "/sessions": {
        POST: async (req) => {
          const tokens = GitHubTokens.safeParse(await req.json().catch(() => null));
          if (!tokens.success) return apiError(400, "invalid_tokens");
          try {
            const identity = await fetchIdentity(githubApiUrl, tokens.data.accessToken);
            const sessionToken = SessionToken.parse(randomToken());
            const userId = store.upsertUser(identity);
            await broker.signIn(userId, tokens.data);
            store.openSession(userId, sessionToken);
            return Response.json({ sessionToken, user: store.user(userId) } satisfies SignInResponse);
          } catch (error) {
            if (error instanceof GitHubAuthError) return apiError(401, "github_rejected_token");
            throw error;
          }
        },
      },
      "/me": {
        GET: (req) => {
          const user = store.userForSession(bearer(req));
          return user ? Response.json(user satisfies User) : unauthorized();
        },
      },
      "/me/github": {
        DELETE: async (req) => {
          const user = store.userForSession(bearer(req));
          if (!user) return unauthorized();
          await broker.revoke(user.id);
          return new Response(null, { status: 204 });
        },
      },
      "/sessions/current": {
        DELETE: (req) => {
          store.endSession(bearer(req));
          return new Response(null, { status: 204 });
        },
      },
      "/bots": {
        GET: (req) => {
          const user = store.userForSession(bearer(req));
          return user ? Response.json(botsOf(user.id)) : unauthorized();
        },
        POST: async (req) => {
          const user = store.userForSession(bearer(req));
          if (!user) return unauthorized();
          const body = CreateBotRequest.safeParse(await req.json().catch(() => null));
          if (!body.success) return apiError(400, "invalid_bot");
          const botToken = BotToken.parse(randomToken());
          const { id } = store.createBot(user.id, body.data.name, botToken);
          try {
            await computers.create({
              botId: id,
              env: {
                CHIEFBOT_CONTROL_URL: workerControlUrl ?? server.url.origin,
                CHIEFBOT_BOT_ID: id,
                CHIEFBOT_BOT_TOKEN: botToken,
                CHIEFBOT_GITHUB_API_URL: githubApiUrl,
              },
            });
            await computers.start(id);
          } catch (error) {
            store.deleteBot(id);
            await computers.destroy(id, { deleteData: true }).catch(() => {});
            return apiError(502, "computer_failed", String(error));
          }
          publish(user.id);
          return Response.json(botOf(user.id, id), { status: 201 });
        },
      },
      "/bots/:id/start": {
        POST: ownBot(async (user, botId) => {
          await setRunning(user.id, botId, true);
          return Response.json(botOf(user.id, botId));
        }),
      },
      "/bots/:id/stop": {
        POST: ownBot(async (user, botId) => {
          await setRunning(user.id, botId, false);
          return Response.json(botOf(user.id, botId));
        }),
      },
      "/bots/:id/take-over": {
        POST: ownBot((user, botId) => setScreenControl(user, botId, "human")),
      },
      "/bots/:id/hand-back": {
        POST: ownBot((user, botId) => setScreenControl(user, botId, "agent")),
      },
      "/bots/:id/screen": {
        GET: ownBot((_user, botId, req, server) => {
          if (!workers.has(botId)) return apiError(409, "bot_offline");
          return upgrade(server, req, { kind: "viewer", botId, streamId: crypto.randomUUID() });
        }),
      },
      "/bots/:id": {
        DELETE: ownBot(async (user, botId, req) => {
          const deleteData = new URL(req.url).searchParams.get("deleteData") === "true";
          await computers.destroy(botId, { deleteData });
          store.deleteBot(botId);
          screenControl.delete(botId);
          workers.get(botId)?.close();
          publish(user.id);
          return new Response(null, { status: 204 });
        }),
      },
      "/bots/:id/model": {
        PUT: ownBot(async (user, botId, req) => {
          const body = SetBotModelRequest.safeParse(await req.json().catch(() => null));
          const offered = modelOptionsOf(user).some(({ id, lockedReason }) => id === body.data?.model && lockedReason === null);
          if (!body.success || !offered) return apiError(400, "model_unavailable");
          store.setBotModel(botId, body.data.model);
          publish(user.id);
          return Response.json(botOf(user.id, botId));
        }),
      },
      "/bots/:id/messages": {
        POST: ownBot(async (user, botId, req) => {
          const body = SendMessageRequest.safeParse(await req.json().catch(() => null));
          if (!body.success) return apiError(400, "invalid_message");
          const sent = sendTurn(user.id, botId, body.data.text);
          if ("error" in sent) return apiError(409, sent.error);
          return Response.json(sent satisfies SendMessageResponse, { status: 202 });
        }),
      },
      // The answer is stored first, so it reaches the worker even if it is offline now.
      "/bots/:id/approvals/:approvalId": {
        POST: ownBot(async (_user, botId, req) => {
          const body = AnswerApprovalRequest.safeParse(await req.json().catch(() => null));
          if (!body.success) return apiError(400, "invalid_answer");
          const approvalId = ApprovalId.safeParse(req.params.approvalId);
          const answer = approvalId.success ? store.answerApproval(botId, approvalId.data, body.data.approved) : null;
          if (!answer || !approvalId.success) return apiError(409, "not_pending");
          publishChat(botId, answer);
          workers.get(botId)?.send(
            JSON.stringify({
              type: "approval-answer",
              approvalId: approvalId.data,
              approved: body.data.approved,
            } satisfies ControlToWorker),
          );
          return new Response(null, { status: 204 });
        }),
      },
      "/bots/:id/routines": {
        GET: ownBot((_user, botId) => Response.json(store.routinesFor(botId))),
        POST: ownBot(async (_user, botId, req) => {
          const routine = await scheduled(req);
          if (routine instanceof Response) return routine;
          return Response.json(store.createRoutine(botId, routine.input, routine.nextDueAt), { status: 201 });
        }),
      },
      "/bots/:id/routines/:routineId": {
        PUT: ownBot(async (_user, botId, req) => {
          const routine = await scheduled(req);
          if (routine instanceof Response) return routine;
          const updated = store.updateRoutine(botId, req.params.routineId, routine.input, routine.nextDueAt);
          return updated ? Response.json(updated) : apiError(404, "not_found");
        }),
        DELETE: ownBot((_user, botId, req) =>
          store.deleteRoutine(botId, req.params.routineId)
            ? new Response(null, { status: 204 })
            : apiError(404, "not_found"),
        ),
      },
      "/bots/:id/chat": {
        GET: ownBot((_user, botId, req, server) => {
          const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
          if (!Number.isInteger(after) || after < 0) return apiError(400, "invalid_after");
          return upgrade(server, req, { kind: "chat", botId, after });
        }),
      },
      "/models": {
        GET: (req) => {
          const user = store.userForSession(bearer(req));
          return user ? Response.json(modelOptionsOf(user)) : unauthorized();
        },
      },
      "/events": {
        GET: (req, server) => {
          const user = store.userForSession(bearer(req));
          if (!user) return unauthorized();
          return upgrade(server, req, { kind: "client", userId: user.id });
        },
      },
      // A worker credential is scoped to the one bot it was made for.
      "/worker/:botId": {
        GET: (req, server) => {
          const bot = ownWorker(req);
          return bot instanceof Response ? bot : upgrade(server, req, { kind: "worker", ...bot });
        },
      },
      // The token broker: the owner's access token, never a refresh token.
      "/worker/:botId/github-token": {
        GET: async (req) => {
          const bot = ownWorker(req);
          if (bot instanceof Response) return bot;
          const token = await broker.accessToken(bot.userId);
          if (token) return Response.json(token);
          return apiError(403, "reauth_needed");
        },
      },
      // Only a stream control opened for this bot, and only once.
      "/worker/:botId/screen/:streamId": {
        GET: (req, server) => {
          const bot = ownWorker(req);
          if (bot instanceof Response) return bot;
          const stream = screenStreams.get(req.params.streamId);
          if (!stream || stream.botId !== bot.botId || stream.screen) {
            return apiError(404, "not_found");
          }
          return upgrade(server, req, { kind: "screen", streamId: req.params.streamId });
        },
      },
    },
    websocket: {
      // Bun's documented way to type ws.data.
      data: {} as SocketData,
      open(ws) {
        if (ws.data.kind === "viewer") {
          const worker = workers.get(ws.data.botId);
          if (!worker) return ws.close();
          screenStreams.set(ws.data.streamId, { botId: ws.data.botId, viewer: ws, screen: null, queued: [] });
          worker.send(JSON.stringify({ type: "screen-open", streamId: ws.data.streamId } satisfies ControlToWorker));
          return;
        }
        if (ws.data.kind === "screen") {
          const stream = screenStreams.get(ws.data.streamId);
          if (!stream) return ws.close();
          stream.screen = ws;
          for (const frame of stream.queued.splice(0)) ws.send(frame);
          return;
        }
        if (ws.data.kind === "client") {
          ws.subscribe(topic(ws.data.userId));
          ws.send(botsEvent(ws.data.userId));
          return;
        }
        if (ws.data.kind === "chat") {
          // Subscribe first: nothing can be published between these two lines.
          ws.subscribe(chatTopic(ws.data.botId));
          for (const event of store.chatAfter(ws.data.botId, ws.data.after)) ws.send(JSON.stringify(event));
          return;
        }
        // One connection per bot: a reconnecting worker replaces its stale socket.
        idle.touch(ws.data.botId);
        workers.get(ws.data.botId)?.close(4000, "replaced");
        workers.set(ws.data.botId, ws);
        greeted.delete(ws.data.botId);
        ws.send(JSON.stringify({ type: "bound", botId: ws.data.botId } satisfies ControlToWorker));
        ws.send(screenControlMessage(ws.data.botId));
        publish(ws.data.userId);
      },
      close(ws) {
        if (ws.data.kind === "viewer" || ws.data.kind === "screen") return endStream(ws.data.streamId);
        if (ws.data.kind !== "worker" || workers.get(ws.data.botId) !== ws) return;
        workers.delete(ws.data.botId);
        greeted.delete(ws.data.botId);
        publish(ws.data.userId);
      },
      message(ws, raw) {
        if (ws.data.kind === "viewer" || ws.data.kind === "screen") {
          const stream = screenStreams.get(ws.data.streamId);
          if (!stream) return;
          if (ws.data.kind === "screen") stream.viewer.send(raw);
          else if (stream.screen) stream.screen.send(raw);
          else stream.queued.push(raw);
          return;
        }
        if (ws.data.kind !== "worker") return;
        const { botId } = ws.data;
        const message = WorkerToControl.parse(JSON.parse(String(raw)));
        if (message.type === "turn-event") {
          return publishChat(botId, store.appendTurnEvent(botId, message.turnId, message.index, message.event));
        }
        if (message.type === "models") return store.setModelReport(ws.data.userId, message.report);
        // Answers the worker may have missed while it was away.
        if (message.activeTurnId) {
          for (const answer of store.answeredApprovals(botId, message.activeTurnId)) {
            ws.send(JSON.stringify({ type: "approval-answer", ...answer } satisfies ControlToWorker));
          }
        }
        // The worker lost every unfinished turn but the one it says it is still running.
        for (const turnId of store.unfinishedTurns(botId)) {
          if (turnId === message.activeTurnId) continue;
          for (const event of store.abandonTurn(botId, turnId, "The bot restarted before it finished this message.")) {
            publishChat(botId, event);
          }
        }
        // Only now may a routine send its turn: a turn sent before the hello
        // would be ended as lost by it.
        greeted.add(botId);
        for (const wake of onlineWaiters.get(botId) ?? []) wake();
        onlineWaiters.delete(botId);
      },
    },
  });

  const scheduler = startScheduler({
    store,
    clock,
    host: {
      setRunning,
      online: (botId) =>
        greeted.has(botId)
          ? Promise.resolve()
          : new Promise((resolve) => onlineWaiters.set(botId, (onlineWaiters.get(botId) ?? new Set()).add(resolve))),
      runTurn(userId, botId, text) {
        const sent = sendTurn(userId, botId, text);
        if ("error" in sent) return sent;
        const done = new Promise<string | null>((resolve) => turnWatchers.set(sent.turnId, { error: null, done: resolve }));
        return { turnId: sent.turnId, done };
      },
    },
  });

  // Pending approvals belong to unfinished turns, so those count as busy too.
  const idle = startIdleStop({
    clock,
    idleMs: idleStopMinutes * 60_000,
    runningBots: store.runningBots,
    busy: (botId) =>
      store.unfinishedTurns(botId).length > 0 ||
      store.routineRunning(botId) ||
      [...screenStreams.values()].some((stream) => stream.botId === botId),
    stop: (userId, botId) => setRunning(userId, botId, false),
  });

  return {
    url: server.url.origin,
    stop: () => {
      idle.stop();
      scheduler.stop();
      server.stop(true);
      store.close();
    },
  };
}

function upgrade(server: Bun.Server<SocketData>, req: Request, data: SocketData) {
  if (server.upgrade(req, { data })) return undefined;
  return apiError(400, "expected_websocket");
}

function randomToken() {
  return crypto.randomUUID() + crypto.randomUUID();
}

function bearer(req: Request) {
  return req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

function unauthorized() {
  return apiError(401, "unauthorized");
}

// Every error body control sends: an ApiError.
function apiError(status: number, error: ApiErrorCode, message?: string) {
  return Response.json((message === undefined ? { error } : { error, message }) satisfies ApiError, { status });
}
