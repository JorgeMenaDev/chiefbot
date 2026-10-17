import type { PermissionHandler, SessionEvent } from "@github/copilot-sdk";
import { ApprovalId, ControlToWorker, type ApprovalKind, type ScreenControl, type TurnId } from "@chiefbot/contracts";
import { rmSync } from "node:fs";
import { approvalFor } from "./approvals.ts";
import { chiefTools } from "./chiefTools.ts";
import { connectorServers } from "./connectorServers.ts";
import type { Clock } from "./clock.ts";
import { controlLink } from "./controlLink.ts";
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
  let session: Promise<BotSession> | null = null;
  // The model set on the open session, or null before the first turn sets one.
  let sessionModel: string | null = null;
  // Approvals the session waits on, each resolved by the user's answer.
  const waiting = new Map<ApprovalId, (approved: boolean) => void>();

  // Puts an approval-request in the active turn's chat and waits, however long,
  // for the user's answer. Null outside a turn: nobody is there to answer.
  async function askUser(ask: { kind: ApprovalKind; detail: string }): Promise<boolean | null> {
    const turnId = link.activeTurnId();
    if (!turnId) return null;
    const approvalId = ApprovalId.parse(`approval_${crypto.randomUUID()}`);
    const answered = new Promise<boolean>((resolve) => waiting.set(approvalId, resolve));
    link.emit(turnId, { type: "approval-request", approvalId, ...ask });
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

  // A task worker's turn was cut short to renew the organization's token
  // (installationSession.ts): the permission requests its runtime waited on are
  // gone, so their approvals are withdrawn. Continuing, the agent asks again if it still needs them.
  function withdrawApprovals() {
    const turnId = link.activeTurnId();
    for (const [approvalId, answer] of waiting) {
      if (turnId) link.emit(turnId, { type: "approval-withdrawn", approvalId });
      answer(false);
    }
    waiting.clear();
  }

  // A task worker's session, set up by its task: on the Copilot `payer` control
  // named (the requester's seat, or the organization's installation tokens) and
  // with the project's `connectors` for the member who asked. Control logs remote
  // connectors' calls in its proxy, and asks the member about those that may
  // write, so this does not ask again; a command connector's call is reported.
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
    return link.openSession(
      copilot,
      payer.kind,
      {
        ...options,
        onPermissionRequest: askUnlessControlDoes,
        mcpServers: connectorServers(connectors, { base, credential: token }),
        onMcpCall: link.reportCalls(connectors),
        onCut: withdrawApprovals,
      },
      "/github-token",
    );
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
    session ??= (task ? taskSession(options, task) : link.openSession(copilot, "seat", options, "/github-token")).then((opened) => {
      opened.on((event: SessionEvent) => link.sessionEvent(event));
      return opened;
    });
    session.catch(() => {
      session = null;
      sessionModel = null;
    });
    return session;
  }

  // Lists the plan's models on the bot's session (it opens it, so the first turn
  // starts faster).
  async function reportModels() {
    try {
      const list = await (await openSession()).rpc.model.list();
      link.send({ type: "models", report: modelReport(list) });
    } catch (error) {
      onModelsError?.(error);
    }
  }

  // Control sends a turn only once the previous one is done. A changed model is
  // set on the session first, so switching mid-conversation keeps the history.
  // A task worker's one turn (`task`) opens its session and runs on the default model.
  async function runTurn(turnId: TurnId, text: string, model: string | null, task?: Extract<ControlToWorker, { type: "run-task" }>) {
    link.begin(turnId);
    try {
      const opened = await openSession(task);
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
    onMessage(message) {
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
      link.stop();
      for (const close of streams) close();
      git?.stop(true);
      if (gitSocket) rmSync(gitSocket, { force: true });
    },
  };
}
