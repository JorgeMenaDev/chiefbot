import type { ServerWebSocket } from "bun";
import {
  BotToken,
  CreateBotRequest,
  GitHubTokens,
  SessionToken,
  type Bot,
  type BotId,
  type ClientEvent,
  type ControlToWorker,
  type SignInResponse,
  type User,
  type UserId,
} from "@chiefbot/contracts";
import type { ComputerProvider } from "./computers/computer.ts";
import { fetchIdentity, GitHubAuthError } from "./github.ts";
import { openStore } from "./store.ts";

export type ControlOptions = {
  port: number;
  dbPath: string;
  // api.github.com in production; a fake in tests.
  githubApiUrl: string;
  // Where bot computers run: Docker locally, a fake in tests.
  computers: ComputerProvider;
  // Control's URL as a bot computer reaches it. Defaults to the URL control listens on.
  workerControlUrl?: string;
};

// What a WebSocket connection is bound to: a desktop client of one user, or the
// worker of exactly one bot.
type SocketData = { kind: "client"; userId: UserId } | { kind: "worker"; userId: UserId; botId: BotId };

// The control plane's HTTP + WebSocket server.
//   POST   /sessions          body GitHubTokens → SignInResponse
//   GET    /me                bearer session    → User
//   DELETE /sessions/current  bearer session    → 204
//   GET    /bots              bearer session    → Bot[]
//   POST   /bots              bearer session, body CreateBotRequest → 201 Bot (its computer is starting)
//   POST   /bots/:id/start    bearer session    → Bot
//   POST   /bots/:id/stop     bearer session    → Bot
//   DELETE /bots/:id          bearer session, ?deleteData=true also deletes its disk → 204
//   WS     /events            bearer session    → ClientEvent on connect and on every change
//   WS     /worker            bearer bot token  → ControlToWorker
export function startControl({ port, dbPath, githubApiUrl, computers, workerControlUrl }: ControlOptions) {
  const store = openStore(dbPath);
  // The connected worker of each bot. A bot is online while it has one.
  const workers = new Map<BotId, ServerWebSocket<SocketData>>();

  const botsOf = (userId: UserId): Bot[] =>
    store.botsFor(userId).map(({ id, name, running }) => ({
      id,
      name,
      status: !running ? "stopped" : workers.has(id) ? "online" : "starting",
    }));
  const botOf = (userId: UserId, botId: BotId) => botsOf(userId).find((bot) => bot.id === botId);
  const topic = (userId: UserId) => `bots:${userId}`;
  const botsEvent = (userId: UserId) => JSON.stringify({ type: "bots", bots: botsOf(userId) } satisfies ClientEvent);
  const publish = (userId: UserId) => server.publish(topic(userId), botsEvent(userId));

  // Runs a bot route for the signed-in owner of :id; 401 or 404 otherwise.
  const ownBot =
    (handle: (user: User, botId: BotId, req: Request) => Promise<Response>) =>
    (req: Bun.BunRequest<"/bots/:id"> | Bun.BunRequest<"/bots/:id/start"> | Bun.BunRequest<"/bots/:id/stop">) => {
      const user = store.userForSession(bearer(req));
      if (!user) return unauthorized();
      const bot = store.botFor(user.id, req.params.id);
      if (!bot) return Response.json({ error: "not_found" }, { status: 404 });
      return handle(user, bot.id, req);
    };

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    routes: {
      "/sessions": {
        POST: async (req) => {
          const tokens = GitHubTokens.safeParse(await req.json().catch(() => null));
          if (!tokens.success) return Response.json({ error: "invalid_tokens" }, { status: 400 });
          try {
            const identity = await fetchIdentity(githubApiUrl, tokens.data.accessToken);
            const sessionToken = SessionToken.parse(randomToken());
            const user = store.signIn(identity, tokens.data, sessionToken);
            return Response.json({ sessionToken, user } satisfies SignInResponse);
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
              env: { CHIEFBOT_CONTROL_URL: workerControlUrl ?? server.url.origin, CHIEFBOT_BOT_TOKEN: botToken },
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
      "/bots/:id": {
        DELETE: ownBot(async (user, botId, req) => {
          const deleteData = new URL(req.url).searchParams.get("deleteData") === "true";
          await computers.destroy(botId, { deleteData });
          store.deleteBot(botId);
          workers.get(botId)?.close();
          publish(user.id);
          return new Response(null, { status: 204 });
        }),
      },
      "/events": {
        GET: (req, server) => {
          const user = store.userForSession(bearer(req));
          if (!user) return unauthorized();
          return upgrade(server, req, { kind: "client", userId: user.id });
        },
      },
      "/worker": {
        GET: (req, server) => {
          const bot = store.botForToken(bearer(req));
          if (!bot) return unauthorized();
          return upgrade(server, req, { kind: "worker", ...bot });
        },
      },
    },
    websocket: {
      // Bun's documented way to type ws.data.
      data: {} as SocketData,
      open(ws) {
        if (ws.data.kind === "client") {
          ws.subscribe(topic(ws.data.userId));
          ws.send(botsEvent(ws.data.userId));
          return;
        }
        // One connection per bot: a reconnecting worker replaces its stale socket.
        workers.get(ws.data.botId)?.close(4000, "replaced");
        workers.set(ws.data.botId, ws);
        ws.send(JSON.stringify({ type: "bound", botId: ws.data.botId } satisfies ControlToWorker));
        publish(ws.data.userId);
      },
      close(ws) {
        if (ws.data.kind !== "worker" || workers.get(ws.data.botId) !== ws) return;
        workers.delete(ws.data.botId);
        publish(ws.data.userId);
      },
      message() {},
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
