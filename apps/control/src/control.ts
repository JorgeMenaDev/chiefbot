import type { ServerWebSocket } from "bun";
import {
  AUTO_MODEL,
  BotToken,
  CreateBotRequest,
  defaultGitHubClientId,
  GitHubTokens,
  SendMessageRequest,
  SessionToken,
  SetBotModelRequest,
  WorkerToControl,
  type Bot,
  type BotId,
  type BrokerRefusal,
  type ChatEvent,
  type ClientEvent,
  type ControlToWorker,
  type ModelOption,
  type ScreenControl,
  type SendMessageResponse,
  type SignInResponse,
  type User,
  type UserId,
} from "@chiefbot/contracts";
import type { ComputerProvider } from "./computers/computer.ts";
import { fetchIdentity, GitHubAuthError, refreshGitHubTokens } from "./github.ts";
import { modelOptions } from "./models.ts";
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
//   WS     /events            bearer session    → ClientEvent on connect and on every change
//   WS     /bots/:id/chat     bearer session, ?after=<seq> → each ChatEvent after seq, then live ones
//   WS     /worker/:botId     bearer bot token of that bot → ControlToWorker; WorkerToControl back
//                             (403 for another bot's)
//   GET    /worker/:botId/github-token  bearer bot token of that bot → BrokeredGitHubToken
//                             (403 BrokerRefusal when the owner must sign in again)
//   WS     /worker/:botId/screen/:streamId  same token ↔ the VNC bytes for one viewer, after screen-open
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
  // Who drives each bot's screen; absent means the agent. Kept in memory, so a
  // control restart hands every screen back to the agent.
  const screenControl = new Map<BotId, ScreenControl>();
  const screenStreams = new Map<string, ScreenStream>();

  // Closes both ends of a screen stream.
  function endStream(streamId: string) {
    const stream = screenStreams.get(streamId);
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
  const publishChat = (botId: BotId, event: ChatEvent | null) => {
    if (event) server.publish(chatTopic(botId), JSON.stringify(event satisfies ChatEvent));
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
    if (bot.botId !== req.params.botId) return Response.json({ error: "wrong_bot" }, { status: 403 });
    return bot;
  };

  // Runs a bot route for the signed-in owner of :id; 401 or 404 otherwise.
  const ownBot =
    (
      handle: (
        user: User,
        botId: BotId,
        req: Request,
        server: Bun.Server<SocketData>,
      ) => Response | undefined | Promise<Response | undefined>,
    ) =>
    (
      req:
        | Bun.BunRequest<"/bots/:id">
        | Bun.BunRequest<"/bots/:id/start">
        | Bun.BunRequest<"/bots/:id/stop">
        | Bun.BunRequest<"/bots/:id/model">
        | Bun.BunRequest<"/bots/:id/take-over">
        | Bun.BunRequest<"/bots/:id/hand-back">
        | Bun.BunRequest<"/bots/:id/screen">
        | Bun.BunRequest<"/bots/:id/messages">
        | Bun.BunRequest<"/bots/:id/chat">,
      server: Bun.Server<SocketData>,
    ) => {
      const user = store.userForSession(bearer(req));
      if (!user) return unauthorized();
      const bot = store.botFor(user.id, req.params.id);
      if (!bot) return Response.json({ error: "not_found" }, { status: 404 });
      return handle(user, bot.id, req, server);
    };

  const server = Bun.serve({
    port,
    hostname,
    routes: {
      "/sessions": {
        POST: async (req) => {
          const tokens = GitHubTokens.safeParse(await req.json().catch(() => null));
          if (!tokens.success) return Response.json({ error: "invalid_tokens" }, { status: 400 });
          try {
            const identity = await fetchIdentity(githubApiUrl, tokens.data.accessToken);
            const sessionToken = SessionToken.parse(randomToken());
            const userId = store.upsertUser(identity);
            await broker.signIn(userId, tokens.data);
            store.openSession(userId, sessionToken);
            return Response.json({ sessionToken, user: store.user(userId) } satisfies SignInResponse);
          } catch (error) {
            if (error instanceof GitHubAuthError) return Response.json({ error: "github_rejected_token" }, { status: 401 });
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
          if (!body.success) return Response.json({ error: "invalid_bot" }, { status: 400 });
          const botToken = BotToken.parse(randomToken());
          const { id } = store.createBot(user.id, body.data.name, botToken);
          try {
            await computers.create({
              botId: id,
              env: {
                CHIEFBOT_CONTROL_URL: workerControlUrl ?? server.url.origin,
                CHIEFBOT_BOT_ID: id,
                CHIEFBOT_BOT_TOKEN: botToken,
              },
            });
            await computers.start(id);
          } catch (error) {
            store.deleteBot(id);
            await computers.destroy(id, { deleteData: true }).catch(() => {});
            return Response.json({ error: "computer_failed", message: String(error) }, { status: 502 });
          }
          publish(user.id);
          return Response.json(botOf(user.id, id), { status: 201 });
        },
      },
      "/bots/:id/start": {
        POST: ownBot(async (user, botId) => {
          await computers.start(botId);
          store.setRunning(botId, true);
          publish(user.id);
          return Response.json(botOf(user.id, botId));
        }),
      },
      "/bots/:id/stop": {
        POST: ownBot(async (user, botId) => {
          await computers.stop(botId);
          store.setRunning(botId, false);
          publish(user.id);
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
          if (!workers.has(botId)) return Response.json({ error: "bot_offline" }, { status: 409 });
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
          if (!body.success || !offered) return Response.json({ error: "model_unavailable" }, { status: 400 });
          store.setBotModel(botId, body.data.model);
          publish(user.id);
          return Response.json(botOf(user.id, botId));
        }),
      },
      "/bots/:id/messages": {
        POST: ownBot(async (user, botId, req) => {
          const body = SendMessageRequest.safeParse(await req.json().catch(() => null));
          if (!body.success) return Response.json({ error: "invalid_message" }, { status: 400 });
          const worker = workers.get(botId);
          if (!worker) return Response.json({ error: "bot_offline" }, { status: 409 });
          if (store.unfinishedTurns(botId).length > 0) return Response.json({ error: "turn_running" }, { status: 409 });
          // The agent waits while the human drives the screen. A turn already running is not paused.
          if (screenControl.get(botId) === "human") return Response.json({ error: "human_has_screen" }, { status: 409 });
          const model = store.botFor(user.id, botId)?.model ?? AUTO_MODEL;
          const started = store.startTurn(botId, body.data.text);
          publishChat(botId, started);
          worker.send(
            JSON.stringify({ type: "run-turn", turnId: started.turnId, text: body.data.text, model } satisfies ControlToWorker),
          );
          return Response.json({ turnId: started.turnId } satisfies SendMessageResponse, { status: 202 });
        }),
      },
      "/bots/:id/chat": {
        GET: ownBot((_user, botId, req, server) => {
          const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
          if (!Number.isInteger(after) || after < 0) return Response.json({ error: "invalid_after" }, { status: 400 });
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
          return Response.json({ error: "reauth_needed" } satisfies BrokerRefusal, { status: 403 });
        },
      },
      // Only a stream control opened for this bot, and only once.
      "/worker/:botId/screen/:streamId": {
        GET: (req, server) => {
          const bot = ownWorker(req);
          if (bot instanceof Response) return bot;
          const stream = screenStreams.get(req.params.streamId);
          if (!stream || stream.botId !== bot.botId || stream.screen) {
            return Response.json({ error: "not_found" }, { status: 404 });
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
        workers.get(ws.data.botId)?.close(4000, "replaced");
        workers.set(ws.data.botId, ws);
        ws.send(JSON.stringify({ type: "bound", botId: ws.data.botId } satisfies ControlToWorker));
        ws.send(screenControlMessage(ws.data.botId));
        publish(ws.data.userId);
      },
      close(ws) {
        if (ws.data.kind === "viewer" || ws.data.kind === "screen") return endStream(ws.data.streamId);
        if (ws.data.kind !== "worker" || workers.get(ws.data.botId) !== ws) return;
        workers.delete(ws.data.botId);
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
        // The worker lost every unfinished turn but the one it says it is still running.
        for (const turnId of store.unfinishedTurns(botId)) {
          if (turnId === message.activeTurnId) continue;
          for (const event of store.abandonTurn(botId, turnId, "The bot restarted before it finished this message.")) {
            publishChat(botId, event);
          }
        }
      },
    },
  });

  return {
    url: server.url.origin,
    stop: () => {
      server.stop(true);
      store.close();
    },
  };
}

function upgrade(server: Bun.Server<SocketData>, req: Request, data: SocketData) {
  if (server.upgrade(req, { data })) return undefined;
  return Response.json({ error: "expected_websocket" }, { status: 400 });
}

function randomToken() {
  return crypto.randomUUID() + crypto.randomUUID();
}

function bearer(req: Request) {
  return req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
