import type { PermissionHandler, SessionEvent } from "@github/copilot-sdk";
import {
  ApprovalId,
  ControlToWorker,
  type AgentConnection,
  type ApprovalKind,
  type ReportedConnectionCall,
  type ScreenControl,
  type TurnId,
  type TurnKey,
} from "@chiefbot/contracts";
import { rmSync } from "node:fs";
import { approvalFor } from "./approvals.ts";
import { chiefTools } from "./chiefTools.ts";
import { connectionCalls, connectionsRoot as defaultConnectionsRoot, stageConnections } from "./connections.ts";
import { connectorServers } from "./connectorServers.ts";
import type { Clock } from "./clock.ts";
import { controlLink, type Turn } from "./controlLink.ts";
import type { BotSession, Copilot } from "./copilot.ts";
import { modelReport } from "./models.ts";
import { pullRequestTool } from "./pullRequest.ts";
import { openScreenStream, type ScreenAddress } from "./screen.ts";

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
  // Times an organization's token renewals (installationSession.ts). Default: the system clock.
  clock?: Clock;
  // Listing the plan's models failed; control keeps its last report.
  onModelsError?: (error: unknown) => void;
  // Where a bot's turns stage its owner's connections. Default: /tmp/chiefbot (connections.ts).
  connectionsRoot?: string;
};

// Dials out to control's /worker/:id WebSocket with the bot's credential (or a task
// worker's /task-worker/:id with its own: the same protocol) and keeps the
// connection up (controlLink.ts), so a turn survives a control restart.
// Runs the turns control sends on the bot's Copilot session, one at a time, and
// streams their events back. After each bind it reports the models the owner's
// Copilot plan offers.
// On `screen-open` it pipes the screen to a viewer through control (screen.ts).
// While the human has the screen (take-over), every tool call waits for hand-back.
// Risky tool calls (approvals.ts) wait for the user's answer, which control relays.
// Pushes and pull requests go through control, which asks the user itself.
// As its owner's chief of staff, the bot hands work to team projects (chiefTools.ts).
// A bot's turn brings its owner's connections: staged for that turn only, their
// skills given to its session, their CLIs' commands that may write asked first and
// every one that runs reported for the log (connections.ts).
// Every call to control in a turn (git's, tools', a task's tokens and connectors)
// carries that turn's key; none is made outside a turn. Only a bot's own Copilot
// seat token is asked for with the bot's credential: its model listing runs between turns.
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
  clock,
  connectionsRoot = defaultConnectionsRoot,
}: WorkerOptions) {
  // Every control route of this computer starts here.
  const base = `${controlUrl}/${route}/${id}`;
  // Each open screen stream's close function.
  const streams = new Set<() => void>();
  // Who drives the screen, as control last said. While it is "human", every tool
  // call of the running turn waits until hand-back: these wake it.
  let screenControl: ScreenControl = "agent";
  const handBackWaiters = new Set<() => void>();
  const agentHasScreen = () =>
    screenControl === "agent" ? Promise.resolve() : new Promise<void>((resolve) => handBackWaiters.add(resolve));
  // The open Copilot session and the turn it was opened for: null for a bot's
  // session opened only to list models.
  let open: { turn: Turn | null; session: Promise<BotSession> } | null = null;
  // The model set on the open session, or null before a turn sets one.
  let sessionModel: string | null = null;
  // Approvals the session waits on, each resolved by the user's answer.
  const waiting = new Map<ApprovalId, (approved: boolean) => void>();
  // The running turn's staged connections, removed when it ends. Whatever a
  // turn a crash cut short left behind goes now.
  let staged: { turnId: TurnId; cleanup: () => void } | null = null;
  stageConnections(connectionsRoot, []);

  // Puts an approval-request in the turn's chat and waits, however long, for the
  // user's answer. Null once that turn is over (or for no turn): nobody is there to answer.
  async function askUser(turn: Turn | null, ask: { kind: ApprovalKind; detail: string }): Promise<boolean | null> {
    if (!turn || !link.running(turn)) return null;
    const approvalId = ApprovalId.parse(`approval_${crypto.randomUUID()}`);
    const answered = new Promise<boolean>((resolve) => waiting.set(approvalId, resolve));
    link.emit(turn.turnId, { type: "approval-request", approvalId, ...ask });
    return answered;
  }

  // The permission handler of `turn`'s session, with the turn's `connections`.
  // It runs safe tool calls once the agent has the screen. A risky one becomes an
  // approval-request in that turn, and the session waits until the user answers.
  // The human may take over while it waits, so an approved call waits for
  // hand-back too. Each command of a connection's CLI that may run is reported
  // for the log first; a failed report does not stop it.
  const permissionFor =
    (turn: Turn | null, connections: AgentConnection[] = []): PermissionHandler =>
    async (request) => {
      await agentHasScreen();
      const ask = approvalFor(request, connections);
      if (ask) {
        const approved = await askUser(turn, ask);
        if (approved === null) return { kind: "reject", feedback: "Nobody is here to approve this outside its turn." };
        if (!approved) return { kind: "reject", feedback: "The user declined this." };
        await agentHasScreen();
      }
      for (const { connection, logged } of connectionCalls(request, connections)) {
        const call: ReportedConnectionCall = { connection: connection.name, command: logged };
        if (turn) await link.fromControl("/connection-calls", turn.key, { method: "POST", body: JSON.stringify(call) }).catch(() => {});
      }
      return ask ? { kind: "approve-once", approvedInteractively: true } : { kind: "approve-once" };
    };

  // A task worker's turn was cut short to renew the organization's token
  // (installationSession.ts): the permission requests its runtime waited on are
  // gone, so their approvals are withdrawn. Continuing, the agent asks again if it still needs them.
  function withdrawApprovals(turn: Turn) {
    for (const [approvalId, answer] of waiting) {
      if (link.running(turn)) link.emit(turn.turnId, { type: "approval-withdrawn", approvalId });
      answer(false);
    }
    waiting.clear();
  }

  // The turn's key, for a tool of its session: a session for no turn has none.
  const keyOf = (turn: Turn | null) => () => {
    if (!turn) throw new Error("No turn is running, so Chiefbot refuses this call.");
    return turn.key;
  };

  // A task worker's session, set up by its task's turn: on the Copilot `payer`
  // control named (the requester's seat, or the organization's installation
  // tokens) and with the project's `connectors` for the member who asked. Control
  // logs remote connectors' calls in its proxy, and asks the member about those
  // that may write, so this does not ask again; a command connector's call is reported.
  function taskSession(
    options: Omit<Parameters<Copilot["openSession"]>[0], "auth">,
    { payer, connectors }: Extract<ControlToWorker, { type: "run-task" }>,
    turn: Turn,
  ) {
    const remote = new Set(connectors.flatMap(({ kind, name }) => (kind === "remote" ? [name] : [])));
    const askUnlessControlDoes: PermissionHandler = async (request, invocation) => {
      if (request.kind !== "mcp" || !remote.has(request.serverName)) return options.onPermissionRequest(request, invocation);
      await agentHasScreen();
      return { kind: "approve-once" };
    };
    return link.openSession(
      copilot,
      payer.kind,
      {
        ...options,
        onPermissionRequest: askUnlessControlDoes,
        mcpServers: connectorServers(connectors, (name) => link.connector(turn, name)),
        onMcpCall: link.reportCalls(connectors, () => turn.key),
        onCut: () => withdrawApprovals(turn),
      },
      () => turn.key,
    );
  }

  // Opens the computer's Copilot session for `turn` (resuming its conversation:
  // its id is the bot's, or task worker's), in place of the open one. Every
  // callback in it holds that turn, so a late one acts in no other. A bot's
  // session for no turn lists its models when the worker binds; a task worker's
  // is opened by its task (`task`). A bot's turn's session gets its staged
  // connections (`connections`, and the skill roots they are under).
  async function openSession(
    turn: Turn | null,
    task?: Extract<ControlToWorker, { type: "run-task" }>,
    { connections, skillDirectories }: { connections: AgentConnection[]; skillDirectories: string[] } = { connections: [], skillDirectories: [] },
  ) {
    const previous = open;
    open = null;
    sessionModel = null;
    await (await previous?.session.catch(() => null))?.disconnect();
    // A task worker does one task for a project: it is no one's chief of staff.
    const turnKey = keyOf(turn);
    const tools = [pullRequestTool({ base, turnKey }), ...(route === "worker" ? chiefTools({ controlUrl, botId: id, turnKey }) : [])];
    const options = { sessionId: id, onPermissionRequest: permissionFor(turn, connections), tools, skillDirectories };
    // A chief always runs on its owner's own Copilot seat.
    const session = (task && turn ? taskSession(options, task, turn) : link.openSession(copilot, "seat", options, () => token)).then((opened) => {
      if (turn) opened.on((event: SessionEvent) => link.sessionEvent(turn, event));
      return opened;
    });
    open = { turn, session };
    session.catch(() => {
      if (open?.session === session) open = null;
    });
    return session;
  }

  // Lists the plan's models on the bot's open session, or a new one (so the
  // first turn's session resumes faster).
  async function reportModels() {
    try {
      const list = await (await (open?.session ?? openSession(null))).rpc.model.list();
      link.send({ type: "models", report: modelReport(list) });
    } catch (error) {
      onModelsError?.(error);
    }
  }

  // Control sends a turn only once the previous one is done. Each turn opens its
  // session (above), with the bot's model set first, so switching
  // mid-conversation keeps the history. A task worker's one turn (`task`) runs on
  // the default model. Git's credential helper hands git this turn's key from
  // now on. A bot's turn stages its owner's `connections` until it ends.
  async function runTurn(
    turnId: TurnId,
    turnKey: TurnKey,
    text: string,
    model: string | null,
    { task, connections = [] }: { task?: Extract<ControlToWorker, { type: "run-task" }>; connections?: AgentConnection[] } = {},
  ) {
    const turn = link.begin(turnId, turnKey);
    git?.reload({ fetch: gitCredential(turn) });
    try {
      const { skillDirectories, cleanup } = stageConnections(connectionsRoot, connections);
      staged = { turnId, cleanup };
      const opened = await openSession(turn, task, { connections, skillDirectories });
      if (model !== null && sessionModel !== model) {
        await opened.setModel(model);
        sessionModel = model;
      }
      await opened.send(text);
    } catch (error) {
      link.fail(turnId, error);
    }
  }

  const link = controlLink({
    base,
    token,
    retryMs,
    ...(clock === undefined ? {} : { clock }),
    parse: (json) => ControlToWorker.parse(json),
    onTurnEnd(turnId) {
      if (staged?.turnId !== turnId) return;
      staged.cleanup();
      staged = null;
    },
    onMessage(message) {
      switch (message.type) {
        case "bound":
          onBound?.();
          // A task worker's session waits for its task, which names its payer; it has no model picker.
          if (route === "worker") void reportModels();
          break;
        case "run-turn":
          void runTurn(message.turnId, message.turnKey, message.text, message.model, { connections: message.connections });
          break;
        case "run-task":
          void runTurn(message.turnId, message.turnKey, message.text, null, { task: message });
          break;
        case "turn-key":
          link.rekey(message.turnId, message.turnKey);
          break;
        case "screen-control":
          screenControl = message.control;
          if (screenControl === "agent") {
            for (const wake of handBackWaiters) wake();
            handBackWaiters.clear();
          }
          break;
        case "screen-open": {
          const close = openScreenStream(`${base.replace(/^http/, "ws")}/screen/${message.streamId}`, token, screen, () => streams.delete(close));
          streams.add(close);
          break;
        }
        case "approval-answer":
          waiting.get(message.approvalId)?.(message.approved);
          waiting.delete(message.approvalId);
          break;
      }
    },
  });

  // Git's credential helper asks here for a turn's key, which control's git proxy
  // takes (never a GitHub token), so it is never written to disk. Each turn
  // installs its own answer (runTurn): its key, while it runs. Git cannot say
  // which turn started it, so a git still running from an ended turn gets the
  // next turn's. Outside a turn there is none: git then fails. A stopped
  // container keeps /tmp, so a stale socket file is removed first.
  const noTurn = () => new Response("No turn is running.", { status: 409 });
  const gitCredential = (turn: Turn) => () => (link.running(turn) ? new Response(`username=chiefbot\npassword=${turn.key}\n`) : noTurn());
  let git: Bun.Server<undefined> | null = null;
  if (gitSocket) {
    rmSync(gitSocket, { force: true });
    git = Bun.serve({ unix: gitSocket, fetch: noTurn });
  }

  return {
    screenControl: () => screenControl,
    stop() {
      link.stop();
      for (const close of streams) close();
      git?.stop(true);
      if (gitSocket) rmSync(gitSocket, { force: true });
    },
  };
}
