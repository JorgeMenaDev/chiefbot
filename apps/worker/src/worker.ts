import type { PermissionHandler, SessionEvent } from "@github/copilot-sdk";
import {
  ApiError,
  ApprovalId,
  BrokeredGitHubToken,
  BrokerRefusal,
  ControlToWorker,
  CopilotInstallationToken,
  type AgentConnector,
  type ApprovalKind,
  type ReportedConnectorCall,
  type ScreenControl,
  type TurnEvent,
  type TurnId,
  type WorkerToControl,
} from "@chiefbot/contracts";
import { rmSync } from "node:fs";
import { approvalFor } from "./approvals.ts";
import { chiefTools } from "./chiefTools.ts";
import { connectorServers } from "./connectorServers.ts";
import type { BotSession, Copilot } from "./copilot.ts";
import { installationSession } from "./installationSession.ts";
import { modelReport } from "./models.ts";
import { pullRequestTool } from "./pullRequest.ts";
import { openScreenStream, type ScreenAddress } from "./screen.ts";
import { newTurnStream, toTurnEvents, type TurnStream } from "./turnEvents.ts";

export type WorkerOptions = {
  // Control's base URL as seen from the computer, e.g. http://host.docker.internal:7410.
  controlUrl: string;
  // Whom the computer works for: a bot (control's /worker/:id routes, the default) or
  // one of a project's task workers (control's /task-worker/:id routes).
  route?: "worker" | "task-worker";
  // The bot's id and credential (CHIEFBOT_BOT_ID, CHIEFBOT_BOT_TOKEN), or the task
  // worker's (CHIEFBOT_TASK_WORKER_ID, CHIEFBOT_TASK_WORKER_TOKEN).
  id: string;
  token: string;
  // The agent engine: the Copilot SDK in a bot computer, a fake in tests.
  copilot: Copilot;
  // The computer's VNC server. Default: x11vnc on 127.0.0.1:5900.
  screen?: ScreenAddress;
  // Unix socket where git's credential helper (gitCredential.ts) asks for the
  // bot's credential for control's git proxy. No socket when unset.
  gitSocket?: string;
  // Wait between reconnects after the connection drops.
  retryMs?: number;
  onBound?: () => void;
  // Listing the plan's models failed; control keeps its last report.
  onModelsError?: (error: unknown) => void;
};

// Dials out to control's /worker/:id WebSocket with the bot's credential (or a task
// worker's /task-worker/:id with its own: the same protocol) and keeps the connection up: control restarts and network drops end in a reconnect.
// Runs the turns control sends on the bot's Copilot session, one at a time, and
// streams their events back. After each bind it reports the models the owner's
// Copilot plan offers. The latest turn's events are kept and resent on
// every reconnect (control stores each once), so a turn survives a control restart.
// On `screen-open` it pipes the screen to a viewer through control (screen.ts).
// While the human has the screen (take-over), every tool call waits for hand-back.
// Risky tool calls (approvals.ts) wait for the user's answer, which control relays.
// Pushes and pull requests go through control, which asks the user itself.
// As its owner's chief of staff, the bot hands work to team projects (chiefTools.ts).
export function startWorker({
  controlUrl,
  route = "worker",
  id,
  token,
  copilot,
  gitSocket,
  screen = { hostname: "127.0.0.1", port: 5900 },
  retryMs = 2000,
  onBound,
  onModelsError,
}: WorkerOptions) {
  // Every control route of this computer starts here.
  const base = `${controlUrl}/${route}/${id}`;
  const url = base.replace(/^http/, "ws");
  // Each open screen stream's close function.
  const streams = new Set<() => void>();
  let socket: WebSocket | null = null;
  let retry: Timer | null = null;
  let stopped = false;
  // Who drives the screen, as control last said. While it is "human", every tool
  // call of the running turn waits until hand-back: these wake it.
  let screenControl: ScreenControl = "agent";
  const handBackWaiters = new Set<() => void>();
  const agentHasScreen = () =>
    screenControl === "agent" ? Promise.resolve() : new Promise<void>((resolve) => handBackWaiters.add(resolve));
  // Every event of the latest turn, numbered by position.
  let latest: { turnId: TurnId; events: TurnEvent[] } | null = null;
  let session: Promise<BotSession> | null = null;
  // The model set on the open session, or null before the first turn sets one.
  let sessionModel: string | null = null;
  // The turn the session is running, and what it has streamed so far.
  let active: ({ turnId: TurnId } & TurnStream) | null = null;
  // Approvals the session waits on, each resolved by the user's answer.
  const waiting = new Map<ApprovalId, (approved: boolean) => void>();

  function send(message: WorkerToControl) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function emit(turnId: TurnId, event: TurnEvent) {
    if (latest?.turnId !== turnId) latest = { turnId, events: [] };
    latest.events.push(event);
    send({ type: "turn-event", turnId, index: latest.events.length - 1, event });
    if (event.type === "done" && active?.turnId === turnId) active = null;
  }

  // Short-lived GitHub access token for the SDK, from control's broker. The
  // worker keeps no token: the SDK asks again when one has an hour or less left.
  async function gitHubToken() {
    const res = await fetch(`${base}/github-token`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      if (BrokerRefusal.safeParse(await res.json().catch(() => null)).success) {
        throw new Error("Chiefbot has lost your GitHub sign-in. Sign in again in the Chiefbot app, then resend.");
      }
      throw new Error(`Control's token broker answered ${res.status}`);
    }
    const { accessToken, expiresAt } = BrokeredGitHubToken.parse(await res.json());
    return { kind: "token" as const, accessToken, expiresIn: Math.floor((expiresAt - Date.now()) / 1000) };
  }

  // Puts an approval-request in the active turn's chat and waits, however long,
  // for the user's answer. Null outside a turn: nobody is there to answer.
  async function askUser(ask: { kind: ApprovalKind; detail: string }): Promise<boolean | null> {
    if (!active) return null;
    const approvalId = ApprovalId.parse(`approval_${crypto.randomUUID()}`);
    const answered = new Promise<boolean>((resolve) => waiting.set(approvalId, resolve));
    emit(active.turnId, { type: "approval-request", approvalId, ...ask });
    return answered;
  }

  // Runs safe tool calls once the agent has the screen. A risky one becomes an
  // approval-request in the chat, and the session waits until the user answers.
  // The human may take over while it waits, so an approved call waits for hand-back too.
  const onPermissionRequest: PermissionHandler = async (request) => {
    await agentHasScreen();
    const ask = approvalFor(request);
    if (!ask) return { kind: "approve-once" };
    const approved = await askUser(ask);
    if (approved === null) return { kind: "reject", feedback: "Nobody is here to approve this outside a turn." };
    if (!approved) return { kind: "reject", feedback: "The user declined this." };
    await agentHasScreen();
    return { kind: "approve-once", approvedInteractively: true };
  };

  // Throws with control's reason when it refuses.
  async function fromControl(path: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    if (res.ok) return res;
    const refusal = ApiError.safeParse(await res.json().catch(() => null));
    throw new Error(refusal.success ? (refusal.data.message ?? refusal.data.error) : `Control answered ${res.status}`);
  }

  // A task worker's session, set up by its task: on the Copilot `payer` control
  // named (the requester's seat, or the organization's installation tokens) and
  // with the project's `connectors` for the member who asked. Control logs remote
  // connectors' calls in its proxy, and asks the member about those that may
  // write, so this does not ask again; a command connector's call runs here, so
  // it is reported. A failed report does not stop the call.
  function taskSession(
    options: Omit<Parameters<Copilot["openSession"]>[0], "auth">,
    { payer, connectors }: Extract<ControlToWorker, { type: "run-task" }>,
  ) {
    const remote = new Set(connectors.flatMap(({ kind, name }) => (kind === "remote" ? [name] : [])));
    const askUnlessControlDoes: PermissionHandler = async (request, invocation) => {
      if (request.kind !== "mcp" || !remote.has(request.serverName)) return options.onPermissionRequest(request, invocation);
      await agentHasScreen();
      return { kind: "approve-once" };
    };
    const withConnectors = {
      ...options,
      onPermissionRequest: askUnlessControlDoes,
      mcpServers: connectorServers(connectors, { base, credential: token }),
      onMcpCall: async (serverName: string, toolName: string) => {
        if (!connectors.some(({ name, kind }: AgentConnector) => name === serverName && kind === "command")) return;
        const call: ReportedConnectorCall = { connector: serverName, tool: toolName };
        await fromControl("/connector-calls", { method: "POST", body: JSON.stringify(call) }).catch(() => {});
      },
    };
    return payer.kind === "org"
      ? installationSession({
          ...withConnectors,
          copilot,
          token: async () => CopilotInstallationToken.parse(await (await fromControl("/installation-token")).json()),
        })
      : copilot.openSession({ ...withConnectors, auth: { kind: "seat", gitHubTokenProvider: gitHubToken } });
  }

  // The computer's one Copilot session. A bot's is opened by reportModels when
  // the worker first binds (or by the next turn, if that open failed). A task
  // worker's is opened by its task (`task`). Its id is the bot's (or task
  // worker's), so after a restart the worker resumes the same conversation.
  function openSession(task?: Extract<ControlToWorker, { type: "run-task" }>) {
    // A task worker does one task for a project: it is no one's chief of staff.
    const tools = [pullRequestTool({ base, token }), ...(route === "worker" ? chiefTools({ controlUrl, botId: id, botToken: token }) : [])];
    const options = { sessionId: id, onPermissionRequest, tools };
    // A chief always runs on its owner's own Copilot seat.
    session ??= (task ? taskSession(options, task) : copilot.openSession({ ...options, auth: { kind: "seat", gitHubTokenProvider: gitHubToken } })).then((opened) => {
      opened.on(onSessionEvent);
      return opened;
    });
    session.catch(() => {
      session = null;
      sessionModel = null;
    });
    return session;
  }

  // Maps the SDK's session events to TurnEvents for the active turn. Sub-agent
  // events (agentId set) are left out: the chat shows the main agent's work.
  function onSessionEvent(event: SessionEvent) {
    if (!active || event.agentId) return;
    const { turnId } = active;
    for (const turnEvent of toTurnEvents(event, active)) emit(turnId, turnEvent);
  }

  // Lists the plan's models on the bot's session (it opens it, so the first turn
  // starts faster).
  async function reportModels() {
    try {
      const list = await (await openSession()).rpc.model.list();
      send({ type: "models", report: modelReport(list) });
    } catch (error) {
      onModelsError?.(error);
    }
  }

  // Control sends a turn only once the previous one is done. A changed model is
  // set on the session first, so switching mid-conversation keeps the history.
  // A task worker's one turn (`task`) opens its session and runs on the default model.
  async function runTurn(turnId: TurnId, text: string, model: string | null, task?: Extract<ControlToWorker, { type: "run-task" }>) {
    active = { turnId, ...newTurnStream() };
    try {
      const opened = await openSession(task);
      if (model !== null && sessionModel !== model) {
        await opened.setModel(model);
        sessionModel = model;
      }
      await opened.send(text);
    } catch (error) {
      emit(turnId, { type: "error", message: error instanceof Error ? error.message : String(error) });
      emit(turnId, { type: "done" });
    }
  }

  function connect() {
    socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    socket.onopen = () => {
      if (latest) {
        const { turnId, events } = latest;
        events.forEach((event, index) => send({ type: "turn-event", turnId, index, event }));
      }
      send({ type: "hello", activeTurnId: active?.turnId ?? null });
    };
    socket.onmessage = (event) => {
      const message = ControlToWorker.parse(JSON.parse(String(event.data)));
      switch (message.type) {
        case "bound":
          onBound?.();
          // A task worker's session waits for its task, which names its payer; it has no model picker.
          if (route === "worker") void reportModels();
          break;
        case "run-turn":
          void runTurn(message.turnId, message.text, message.model);
          break;
        case "run-task":
          void runTurn(message.turnId, message.text, null, message);
          break;
        case "screen-control":
          screenControl = message.control;
          if (screenControl === "agent") {
            for (const wake of handBackWaiters) wake();
            handBackWaiters.clear();
          }
          break;
        case "screen-open": {
          const close = openScreenStream(`${url}/screen/${message.streamId}`, token, screen, () =>
            streams.delete(close),
          );
          streams.add(close);
          break;
        }
        case "approval-answer":
          waiting.get(message.approvalId)?.(message.approved);
          waiting.delete(message.approvalId);
          break;
      }
    };
    socket.onclose = () => {
      if (!stopped) retry = setTimeout(connect, retryMs);
    };
  }
  connect();

  // Git's credential helper asks here for the computer's credential, which control's
  // git proxy takes (never a GitHub token), so it is never written to disk. A
  // stopped container keeps /tmp, so a stale socket file is removed first.
  let git: Bun.Server<undefined> | null = null;
  if (gitSocket) {
    rmSync(gitSocket, { force: true });
    git = Bun.serve({ unix: gitSocket, fetch: () => new Response(`username=chiefbot\npassword=${token}\n`) });
  }

  return {
    screenControl: () => screenControl,
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
      for (const close of streams) close();
      git?.stop(true);
      if (gitSocket) rmSync(gitSocket, { force: true });
    },
  };
}
