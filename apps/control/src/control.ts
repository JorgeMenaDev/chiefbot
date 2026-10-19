import type { ServerWebSocket } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AnswerApprovalRequest,
  ApprovalId,
  BotToken,
  CreateBotRequest,
  GitHubTokens,
  PullRequestArgs,
  RoutineInput,
  SendMessageRequest,
  SessionToken,
  SetBotModelRequest,
  WorkerToControl,
  type Bot,
  type BotId,
  type ClientEvent,
  type ControlToWorker,
  type ModelOption,
  type OpenedPullRequest,
  type ProjectId,
  type ScreenControl,
  type SendMessageResponse,
  type SignInResponse,
  type User,
  type UserId,
} from "@chiefbot/contracts";
import { systemClock, type Clock } from "@chiefbot/worker/clock";
import { controlApprovals } from "./approvals.ts";
import type { ComputerProvider } from "./computers/computer.ts";
import { copilotIdentity, type CopilotTokenMinter } from "./copilotIdentity.ts";
import { chiefHost } from "./handoffs.ts";
import { copilotRequestsToken, fetchIdentity, GitHubAuthError, refreshGitHubTokens, type GitHubAppKey } from "./github.ts";
import { apiError, bearer, unauthorized } from "./http.ts";
import { startIdleStop } from "./idle.ts";
import { modelOptions } from "./models.ts";
import { repoAccess, type RepoAgent } from "./repos.ts";
import { startScheduler } from "./routines.ts";
import { screenTunnel } from "./screens.ts";
import { nextDueAt } from "./schedule.ts";
import { connectorHost } from "./connectors/connectors.ts";
import { localContextStore, type ContextStore } from "./contextStore.ts";
import { projectHost, type ProjectSocketData } from "./projects.ts";
import { subscriptionHost } from "./subscriptions.ts";
import { taskWorkerHost, type TaskWorkerSocketData } from "./taskWorkers.ts";
import { localSecretStore, type SecretStore } from "./secrets/secretStore.ts";
import { openStore } from "./store.ts";
import { tokenBroker } from "./tokens.ts";
import { botTurn, heldTurn, type BotTurn } from "./turnKeys.ts";
import { chatTurns } from "./turns.ts";
import { workspaceRoutes } from "./workspaces.ts";

export type ControlOptions = {
  port: number;
  // Interface to listen on. Default 127.0.0.1.
  hostname?: string;
  dbPath: string;
  // api.github.com in production; a fake in tests.
  githubApiUrl: string;
  // github.com, for the refresh grant. Defaults to githubApiUrl: the fake serves both.
  githubUrl?: string;
  // Client ID of the deployer's sign-in app (`bun run setup`), which has no
  // repository permissions. The desktop signs in with it; refreshes must use the
  // same one. Its tokens are what bot computers get, for the Copilot SDK.
  githubClientId: string;
  // The repo app's ID and private key: control mints its installation tokens to
  // reach repos for bots (repos.ts), and never hands them to a bot computer.
  githubApp: GitHubAppKey;
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
  // pending approval, no screen viewer and no routine run in progress; a
  // project's after this long with no coordinator turn running or queued. Default 30.
  idleStopMinutes?: number;
  // A project's worker that waits this long on one approval stops, keeping its disk. Default 60.
  approvalWaitMinutes?: number;
  // Mints the installation tokens an organization pays for Copilot with.
  // Defaults to the repo app's (github.ts copilotRequestsToken); a fake in tests.
  copilotTokens?: CopilotTokenMinter;
  // Control's URL as users' browsers reach it, for OAuth callbacks. Defaults to the URL control listens on.
  publicUrl?: string;
  // The name of the bot a new user gets at their first sign-in, once: deleting
  // it is for good. None when unset; index.ts passes one.
  firstBot?: string;
  // Where projects' shared context files live. Defaults to a context folder
  // next to dbPath (a fresh temporary one for an in-memory database).
  context?: ContextStore;
};

// What a WebSocket connection is bound to: a desktop client of one user, one
// bot's chat from `after` on, the worker of exactly one bot, or one end of a
// screen stream: the owner's viewer, or the bot's worker piping its VNC server.
// Or a project's: its coordinator, or a member's chat with it (projects.ts), or one
// of its task workers (taskWorkers.ts).
type SocketData =
  | { kind: "client"; userId: UserId }
  | { kind: "chat"; botId: BotId; after: number }
  | { kind: "worker"; userId: UserId; botId: BotId }
  | { kind: "viewer"; botId: BotId; streamId: string }
  | { kind: "screen"; streamId: string }
  | ProjectSocketData
  | TaskWorkerSocketData;

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
//   WS     /bots/:id/screen   bearer session    ↔ the screen's RFB bytes (noVNC speaks it); 409 while offline or stopping
//   DELETE /bots/:id          bearer session, ?deleteData=true also deletes its disk → 204
//   PUT    /bots/:id/model    bearer session, body SetBotModelRequest → Bot; the bot's next turn runs on it
//                             (400 model_unavailable when the user's plan does not offer it or it is locked)
//   POST   /bots/:id/messages bearer session, body SendMessageRequest → 202 SendMessageResponse
//                             (409 when the bot is not online, is stopping, is still on a turn or the human has its screen)
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
//                             (403 BrokerRefusal when the owner must sign in again). The bot token, not a
//                             turn key: a bot always acts for its owner, who also needs it between turns,
//                             for the model picker.
//   WS     /worker/:botId/screen/:streamId  same token ↔ the VNC bytes for one viewer, after screen-open
//   POST   /worker/:botId/pull-requests  bearer the key of the bot's running turn (403 invalid_turn_key
//                             otherwise), body PullRequestArgs → 201 OpenedPullRequest once the owner
//                             approves in that turn (403 declined, 409 no_turn, 404 repo_not_found, 403
//                             repo_read_only or app_not_installed, 502 github_failed)
//   GET    /git/:owner/:repo/info/refs, POST /git/:owner/:repo/git-upload-pack|git-receive-pack
//                             git's smart HTTP, Basic auth with the key of a bot's or task worker's
//                             running turn as the password: control's git proxy to GitHub. A push waits
//                             for approval in that turn (repos.ts). Errors are text/plain for git to
//                             print, not ApiErrors.
//   …      /workspaces, /invites  workspaces, members and invites (workspaces.ts)
//   …      /workspaces/:id/projects, /projects, /coordinator  projects, their coordinators,
//                             task ledgers and chats (projects.ts)
//   …      /projects/:id/workers, /task-worker  projects' task workers (taskWorkers.ts)
//   …      /workspaces/:id/connectors, /workspaces/:id/checklist, /connectors/oauth/callback,
//          /coordinator/:projectId/mcp  connectors, the access checklist and the MCP proxy
//                             (connectors/connectors.ts)
//   …      /projects/:id/subscriptions  what a project listens to: CI runs, issue queries and
//                             schedules, each event handled once (subscriptions.ts)
//   POST   /worker/:botId/chief-tools  a bot's tools as its owner's chief of staff, with its running
//                             turn's key: handing work to projects and watching it (handoffs.ts)
//
// Every other error body is an ApiError (packages/contracts errors.ts).
//
// The screen never listens beyond the computer's loopback: for each viewer,
// control asks the worker to dial back and pipe x11vnc, and joins the two sockets.
export function startControl({
  port,
  hostname = "127.0.0.1",
  dbPath,
  githubApiUrl,
  githubUrl = githubApiUrl,
  githubClientId,
  githubApp,
  secrets = localSecretStore({ dbPath, key: crypto.getRandomValues(new Uint8Array(32)) }),
  computers,
  workerControlUrl,
  clock = systemClock,
  idleStopMinutes = 30,
  approvalWaitMinutes = 60,
  context,
  copilotTokens = (repo) => copilotRequestsToken(githubApiUrl, githubApp, repo),
  publicUrl,
  firstBot,
}: ControlOptions) {
  const store = openStore(dbPath);
  // An in-memory database gets a temporary context folder, removed on stop.
  const tempContext = context || dbPath !== ":memory:" ? null : mkdtempSync(join(tmpdir(), "chiefbot-context-"));
  context ??= localContextStore(tempContext ?? join(dirname(dbPath), "context"));
  const broker = tokenBroker({
    store,
    secrets,
    refresh: (refreshToken) => refreshGitHubTokens(githubUrl, githubClientId, refreshToken),
    onChange: (userId) =>
      server.publish(topic(userId), JSON.stringify({ type: "user", user: store.user(userId) } satisfies ClientEvent)),
  });
  // The connected worker of each bot. A bot is online while it has one.
  const workers = new Map<BotId, ServerWebSocket<SocketData>>();
  // Bots whose computer control is stopping. They take no new turn, routine run
  // or screen viewer: it would die with the computer.
  const stopping = new Set<BotId>();
  // Who drives each screen and the viewers' streams (screens.ts).
  const screens = screenTunnel({ onStreamEnd: (botId) => idle.touch(botId) });
  // Starting turns, the chat topics and worker hellos (turns.ts).
  const turns = chatTurns({
    store,
    publish: (topic, message) => server.publish(topic, message),
    workerOf: (botId) => workers.get(botId),
    humanHasScreen: (botId) => screens.controlOf(botId) === "human",
    stopping: (botId) => stopping.has(botId),
    onEvent: (botId, event) => {
      idle.touch(botId);
      if (event.event.type === "done") approvals.turnEnded(event.turnId);
    },
  });
  // Approvals control asks for itself, and the repo access they guard.
  const approvals = controlApprovals();
  // A bot's turn as repo access sees it: its owner, asked in that turn.
  const botAgent = ({ botId, userId, turnId }: BotTurn): RepoAgent => ({
    userId,
    ask: (kind, detail, signal) =>
      approvals.ask((approvalId) => {
        const event = store.requestApproval(botId, turnId, { approvalId, kind, detail });
        turns.publishChat(botId, event);
        return event;
      }, signal),
  });
  const repos = repoAccess({
    githubUrl,
    githubApiUrl,
    app: githubApp,
    ownerLogin: async (userId) => ((await broker.accessToken(userId)) ? (store.user(userId)?.login ?? null) : null),
    agentFor: (key) => {
      const turn = store.turnKeys.holder(key);
      if (turn?.agent === "bot") return botAgent(turn);
      return turn?.agent === "task-worker" ? taskWorkers.agentOf(turn) : null;
    },
  });

  // Who pays for each agent run's Copilot (copilotIdentity.ts).
  const payerOf = copilotIdentity({ store, broker, mint: copilotTokens });
  // Connectors, the access checklist, and the MCP proxy agents reach them through (connectors/connectors.ts).
  const connectors = connectorHost({
    store,
    secrets,
    publicUrl: () => publicUrl ?? server.url.origin,
    ask: { coordinator: (...args) => projects.ask(...args), taskWorker: (...args) => taskWorkers.ask(...args) },
    turnSignal: approvals.turnSignal,
  });
  // The handoffs watcher: tells chiefs when their task needs input or is done.
  // Without a project, it looks at every one.
  const watchHandoffs = (projectId?: ProjectId) => {
    for (const { botId, event } of store.handoffs.watch(projectId)) turns.publishChat(botId, event);
  };

  // The projects' task workers, one throwaway computer each (taskWorkers.ts).
  const taskWorkers = taskWorkerHost({
    store,
    payerOf,
    connectorsFor: connectors.agentConnectors,
    computers,
    approvals,
    approvalWaitMinutes,
    clock,
    pullRequest: repos.pullRequest,
    controlUrlForComputers: () => workerControlUrl ?? server.url.origin,
    publishToUser: (userId, event) => server.publish(topic(userId), JSON.stringify(event satisfies ClientEvent)),
    onLedgerChange: watchHandoffs,
    upgrade: (req, data) => upgrade(server, req, data),
  });

  // Projects, their coordinators and the coordinators' scheduler (projects.ts).
  const projects = projectHost({
    store,
    payerOf,
    computers,
    context,
    workers: taskWorkers,
    approvals,
    githubApiUrl,
    repoReadToken: repos.readToken,
    controlUrlForComputers: () => workerControlUrl ?? server.url.origin,
    publish: (topic, message) => server.publish(topic, message),
    publishToUser: (userId, event) => server.publish(topic(userId), JSON.stringify(event satisfies ClientEvent)),
    upgrade: (req, data) => upgrade(server, req, data),
    connectorsFor: connectors.agentConnectors,
    onLedgerChange: watchHandoffs,
    onActivity: (projectId) => coordinatorIdle.touch(projectId),
  });
  // Chiefs of staff handing work to projects (handoffs.ts).
  const chiefs = chiefHost({ store, projects });
  // What projects listen to: polled CI runs and issue queries, and schedules (subscriptions.ts).
  const subscriptions = subscriptionHost({ store, clock, connectors, projects });

  const botsOf = (userId: UserId): Bot[] =>
    store.botsFor(userId).map(({ id, name, running, model }) => ({
      id,
      name,
      status: !running ? "stopped" : stopping.has(id) ? "stopping" : workers.has(id) ? "online" : "starting",
      model,
      screenControl: screens.controlOf(id),
    }));
  const botOf = (userId: UserId, botId: BotId) => botsOf(userId).find((bot) => bot.id === botId);
  const modelOptionsOf = (user: User): ModelOption[] => modelOptions(store.modelReport(user.id), user.copilotPlan);
  const topic = (userId: UserId) => `bots:${userId}`;
  const botsEvent = (userId: UserId) => JSON.stringify({ type: "bots", bots: botsOf(userId) } satisfies ClientEvent);
  const publish = (userId: UserId) => server.publish(topic(userId), botsEvent(userId));
  const screenControlMessage = (botId: BotId) =>
    JSON.stringify({ type: "screen-control", control: screens.controlOf(botId) } satisfies ControlToWorker);

  // Take-over and hand-back: tell the bot's worker and the owner's clients.
  function setScreenControl(user: User, botId: BotId, control: ScreenControl) {
    screens.setControl(botId, control);
    workers.get(botId)?.send(screenControlMessage(botId));
    publish(user.id);
    return Response.json(botOf(user.id, botId));
  }

  // Adds a bot to the user's list at once and starts its computer. If the
  // computer fails to start, the bot is gone again and this throws.
  const launchBot = async (userId: UserId, name: string) => {
    const botToken = BotToken.parse(randomToken());
    const { id } = store.createBot(userId, name, botToken);
    try {
      await computers.create({
        id,
        env: { CHIEFBOT_CONTROL_URL: workerControlUrl ?? server.url.origin, CHIEFBOT_BOT_ID: id, CHIEFBOT_BOT_TOKEN: botToken },
      });
      await computers.start(id);
      return id;
    } catch (error) {
      store.deleteBot(id);
      await computers.destroy(id, { deleteData: true }).catch(() => {});
      throw error;
    } finally {
      publish(userId);
    }
  };

  // A stop marks the bot stopping first, so no new work lands on a computer about to go.
  const setRunning = async (userId: UserId, botId: BotId, running: boolean) => {
    if (!running) {
      stopping.add(botId);
      publish(userId);
    }
    try {
      await (running ? computers.start(botId) : computers.stop(botId));
      store.setRunning(botId, running);
    } finally {
      stopping.delete(botId);
      publish(userId);
    }
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
      ...workspaceRoutes(store, async (workspaceId, userId) => {
        projects.memberRemoved(workspaceId, userId);
        taskWorkers.memberRemoved(workspaceId, userId);
      }),
      ...projects.routes,
      ...taskWorkers.routes,
      ...connectors.routes,
      ...chiefs.routes,
      ...subscriptions.routes,
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
            // The first bot shows in the list now; its computer starts after sign-in
            // returns. A failed start leaves it to the next sign-in.
            if (firstBot && store.claimFirstBot(userId)) {
              launchBot(userId, firstBot).catch(() => store.releaseFirstBot(userId));
            }
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
          try {
            const id = await launchBot(user.id, body.data.name);
            return Response.json(botOf(user.id, id), { status: 201 });
          } catch (error) {
            return apiError(502, "computer_failed", String(error));
          }
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
          if (stopping.has(botId)) return apiError(409, "bot_stopping");
          return upgrade(server, req, { kind: "viewer", botId, streamId: crypto.randomUUID() });
        }),
      },
      "/bots/:id": {
        DELETE: ownBot(async (user, botId, req) => {
          const deleteData = new URL(req.url).searchParams.get("deleteData") === "true";
          await computers.destroy(botId, { deleteData });
          store.deleteBot(botId);
          screens.forget(botId);
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
          const sent = turns.sendTurn(user.id, botId, body.data.text);
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
          turns.publishChat(botId, answer);
          approvals.answered(approvalId.data, body.data.approved);
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
      // The token broker: a chief always runs on its owner's seat, so the owner's
      // access token, never a refresh token.
      "/worker/:botId/github-token": {
        GET: async (req) => {
          const bot = ownWorker(req);
          if (bot instanceof Response) return bot;
          const token = await payerOf({ kind: "chief", ownerId: bot.userId })?.token();
          if (token && "kind" in token && token.kind === "seat") return Response.json(token.token);
          return apiError(403, "reauth_needed");
        },
      },
      // The bot's create_pull_request tool. Waits, however long, for the owner's answer.
      "/worker/:botId/pull-requests": {
        POST: async (req, server) => {
          const bot = heldTurn(store.turnKeys, req, botTurn(req.params.botId));
          if (bot instanceof Response) return bot;
          const args = PullRequestArgs.safeParse(await req.json().catch(() => null));
          if (!args.success) return apiError(400, "invalid_pull_request");
          server.timeout(req, 0);
          const opened = await repos.pullRequest(botAgent(bot), args.data, req.signal);
          if ("error" in opened) return apiError(opened.status, opened.error, opened.message);
          return Response.json(opened satisfies OpenedPullRequest, { status: 201 });
        },
      },
      "/git/:owner/:repo/info/refs": { GET: (req, server) => repos.git(req, server, req.params) },
      "/git/:owner/:repo/git-upload-pack": { POST: (req, server) => repos.git(req, server, req.params) },
      "/git/:owner/:repo/git-receive-pack": { POST: (req, server) => repos.git(req, server, req.params) },
      // Only a stream control opened for this bot, and only once.
      "/worker/:botId/screen/:streamId": {
        GET: (req, server) => {
          const bot = ownWorker(req);
          if (bot instanceof Response) return bot;
          if (!screens.joinable(bot.botId, req.params.streamId)) return apiError(404, "not_found");
          return upgrade(server, req, { kind: "screen", streamId: req.params.streamId });
        },
      },
    },
    websocket: {
      // Bun's documented way to type ws.data.
      data: {} as SocketData,
      open(ws) {
        if (ws.data.kind === "coordinator" || ws.data.kind === "project-chat") return projects.open(ws, ws.data);
        if (ws.data.kind === "task-worker") return taskWorkers.open(ws, ws.data);
        if (ws.data.kind === "viewer") {
          const worker = workers.get(ws.data.botId);
          if (!worker) return ws.close();
          screens.openViewer(ws.data.botId, ws.data.streamId, ws);
          worker.send(JSON.stringify({ type: "screen-open", streamId: ws.data.streamId } satisfies ControlToWorker));
          return;
        }
        if (ws.data.kind === "screen") {
          if (!screens.joinScreen(ws.data.streamId, ws)) ws.close();
          return;
        }
        if (ws.data.kind === "client") {
          ws.subscribe(topic(ws.data.userId));
          ws.send(botsEvent(ws.data.userId));
          return;
        }
        if (ws.data.kind === "chat") {
          // Subscribe first: nothing can be published between these two lines.
          ws.subscribe(turns.chatTopic(ws.data.botId));
          for (const event of store.chatAfter(ws.data.botId, ws.data.after)) ws.send(JSON.stringify(event));
          return;
        }
        // One connection per bot: a reconnecting worker replaces its stale socket.
        idle.touch(ws.data.botId);
        workers.get(ws.data.botId)?.close(4000, "replaced");
        workers.set(ws.data.botId, ws);
        turns.workerChanged(ws.data.botId);
        ws.send(JSON.stringify({ type: "bound" } satisfies ControlToWorker));
        ws.send(screenControlMessage(ws.data.botId));
        publish(ws.data.userId);
      },
      close(ws) {
        if (ws.data.kind === "coordinator" || ws.data.kind === "project-chat") return projects.close(ws, ws.data);
        if (ws.data.kind === "task-worker") return taskWorkers.close(ws, ws.data);
        if (ws.data.kind === "viewer" || ws.data.kind === "screen") return screens.end(ws.data.streamId);
        if (ws.data.kind !== "worker" || workers.get(ws.data.botId) !== ws) return;
        workers.delete(ws.data.botId);
        turns.workerChanged(ws.data.botId);
        publish(ws.data.userId);
      },
      message(ws, raw) {
        if (ws.data.kind === "coordinator" || ws.data.kind === "project-chat") return projects.message(ws.data, raw);
        if (ws.data.kind === "task-worker") return taskWorkers.message(ws.data, raw);
        if (ws.data.kind === "viewer" || ws.data.kind === "screen") return screens.relay(ws.data.streamId, ws.data.kind, raw);
        if (ws.data.kind !== "worker") return;
        const message = WorkerToControl.parse(JSON.parse(String(raw)));
        if (message.type === "models") return store.setModelReport(ws.data.userId, message.report);
        turns.fromWorker(ws.data.userId, ws.data.botId, message, (reply) => ws.send(JSON.stringify(reply)));
      },
    },
  });

  const scheduler = startScheduler({
    store,
    clock,
    host: {
      setRunning,
      online: turns.online,
      humanHasScreen: (botId) => screens.controlOf(botId) === "human",
      runTurn: turns.runTurn,
    },
  });

  subscriptions.start();
  // Worker computers left behind by a control that stopped mid-way go now.
  void taskWorkers.recover().catch((error: unknown) => console.error("could not recover task workers:", error));

  // Pending approvals belong to unfinished turns, so those count as busy too.
  const idle = startIdleStop({
    clock,
    idleMs: idleStopMinutes * 60_000,
    running: () => store.runningBots().map(({ botId, userId }) => ({ id: botId, userId })),
    busy: (botId) =>
      store.unfinishedTurns(botId).length > 0 ||
      store.routineRunning(botId) ||
      screens.watched(botId),
    stop: ({ id, userId }) => setRunning(userId, id, false),
  });
  // Coordinators' computers stop the same way; the next queued turn starts them again (projects.ts).
  const coordinatorIdle = startIdleStop({
    clock,
    idleMs: idleStopMinutes * 60_000,
    running: projects.awake,
    busy: projects.busy,
    stop: ({ id }) => projects.sleep(id),
  });

  // A ledger change whose notice a crash kept from its chief is told now.
  watchHandoffs();

  return {
    url: server.url.origin,
    stop: () => {
      idle.stop();
      coordinatorIdle.stop();
      taskWorkers.stop();
      scheduler.stop();
      subscriptions.stop();
      server.stop(true);
      store.close();
      if (tempContext) rmSync(tempContext, { recursive: true, force: true });
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
