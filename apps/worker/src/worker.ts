import type { ElicitationResult, MCPServerConfig, PermissionHandler, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import {
  ACCESS_MODES,
  ATTACHMENTS,
  ENGINEER_SETUP,
  ApprovalId,
  ControlToWorker,
  DEFAULT_ACCESS,
  QuestionId,
  type AccessMode,
  type AgentConnection,
  type ApprovalKind,
  type EngineerSetup,
  type QuestionResult,
  type ReasoningEffort,
  type ScreenControl,
  type SentAttachment,
  type TurnId,
  type TurnKey,
} from "@chiefbot/contracts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { approvalFor } from "./approvals.ts";
import { chiefTools } from "./chiefTools.ts";
import { computerInstructions, computerTool, displayCommands, type CommandRunner } from "./computerUse.ts";
import { connectionsRoot as defaultConnectionsRoot, stageConnections } from "./connections.ts";
import { connectorServers } from "./connectorServers.ts";
import type { Clock } from "./clock.ts";
import { controlLink, type Turn } from "./controlLink.ts";
import type { BotSession, Copilot, FileAttachment, QuestionRequest, Questions } from "./copilot.ts";
import { agentEnv } from "./copilotSdk.ts";
import { setUpEngineer, setupShell as shellOf, type EngineerReady, type SetupShell } from "./engineerSetup.ts";
import { modelReport } from "./models.ts";
import { pullRequestTool } from "./pullRequest.ts";
import { secretRedactor, turnEventRedactor } from "./secretRedactor.ts";
import { elicitationResult, questionForm } from "./questions.ts";
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
  // Runs the computer tool's xdotool and scrot commands on the screen. Default:
  // on display :1 (computerUse.ts); a fake display in tests.
  screenCommands?: CommandRunner;
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
  // Where a turn saves the files sent with its message, in a folder per turn.
  // Default: attachments/ in the bot's workspace, so the agent can open them later too.
  attachmentsRoot?: string;
  // Where a task worker (an engineer) clones its repo. Default: the computer's workspace.
  workspace?: string;
  // Runs an engineer's setup commands (engineerSetup.ts). Default: sh with the
  // worker's environment minus its tokens; index.ts adds the git proxy's config.
  setupShell?: SetupShell;
};

// Dials out to control's /worker/:id WebSocket with the bot's credential (or a task
// worker's /task-worker/:id with its own: the same protocol) and keeps the
// connection up (controlLink.ts), so a turn survives a control restart.
// Runs the turns control sends on the bot's Copilot session, one at a time, and
// streams their events back. After each bind it reports the models the owner's
// Copilot plan offers.
// On `screen-open` it pipes the screen to a viewer through control (screen.ts).
// The agent sees and operates that screen with its `computer` tool, which its
// instructions name (computerUse.ts).
// While the human has the screen (take-over), every tool call waits for hand-back,
// and a computer call already running stops before its next command. One whose
// turn ends, or that its runtime cancels, stops at once.
// Risky tool calls (approvals.ts) wait for the user's answer, which control relays.
// So does a bot's question to its user (Copilot's ask_user forms, questions.ts).
// Pushes and pull requests go through control, which asks the user itself.
// As its owner's chief of staff, the bot hands work to team projects (chiefTools.ts).
// A task worker is one of a project's engineers: before its agent starts it
// sets up its computer (engineerSetup.ts), each step reported in its turn, and a
// step that fails ends its turn. Its session works in the clone with the repo's
// instructions, skills and MCP servers, and its runtime holds the project's
// secrets until its turn ends, when the session closes.
// A bot's turn brings its owner's connections: staged for that turn only, their
// skills given to its session, their CLIs' commands that may write asked first and
// every run of them sent to control with the turn's end (connections.ts). The files
// sent with its message are saved in the workspace and attached to its prompt.
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
  screenCommands = displayCommands(),
  retryMs = 2000,
  onBound,
  onModelsError,
  clock,
  connectionsRoot = defaultConnectionsRoot,
  attachmentsRoot = "/home/bot/workspace/attachments",
  workspace = "/home/bot/workspace",
  setupShell = shellOf(agentEnv(process.env)),
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
  // Approvals the session waits on, each resolved by the user's answer, or with
  // null when its turn ends first.
  const waiting = new Map<ApprovalId, { turnId: TurnId; answer: (approved: boolean | null) => void }>();
  // Questions the bot's agent waits on, by their SDK request's id too: each is
  // settled by the user's answer, or with null once it is withdrawn.
  const asking = new Map<QuestionId, { turnId: TurnId; requestId: string; answer: (result: QuestionResult | null) => void }>();
  // The running turn's staged connections, removed when it ends. Whatever a
  // turn a crash cut short left behind goes now.
  let staged: (ReturnType<typeof stageConnections> & { turnId: TurnId }) | null = null;
  stageConnections(connectionsRoot, []);

  // Puts an approval-request in the turn's chat and waits, however long, for the
  // user's answer. Null once that turn is over (or for no turn): nobody is there to answer.
  async function askUser(turn: Turn | null, ask: { kind: ApprovalKind; detail: string }): Promise<boolean | null> {
    if (!turn || !link.running(turn)) return null;
    const approvalId = ApprovalId.parse(`approval_${crypto.randomUUID()}`);
    const answered = new Promise<boolean | null>((answer) => waiting.set(approvalId, { turnId: turn.turnId, answer }));
    link.emit(turn.turnId, { type: "approval-request", approvalId, ...ask });
    return answered;
  }

  // The permission handler of `turn`'s session, with the turn's `connections` and
  // the bot's `access` mode. It runs the tool calls that mode lets run once the
  // agent has the screen. Any other becomes an approval-request in that turn, and
  // the session waits until the user answers. The human may take over while it
  // waits, so an approved call waits for hand-back too. Whatever it waited on, and
  // whatever the mode, nothing is granted once its turn is over.
  const permissionFor =
    (turn: Turn | null, connections: AgentConnection[] = [], access: AccessMode = DEFAULT_ACCESS): PermissionHandler =>
    async (request) => {
      const over: PermissionRequestResult = { kind: "reject", feedback: "Nobody is here to approve this outside its turn." };
      const ended = () => turn !== null && !link.running(turn);
      await agentHasScreen();
      if (ended()) return over;
      const ask = approvalFor(request, connections, access);
      if (!ask) return { kind: "approve-once" };
      const approved = await askUser(turn, ask);
      if (approved === null || ended()) return over;
      if (!approved) return { kind: "reject", feedback: "The user declined this." };
      await agentHasScreen();
      return ended() ? over : { kind: "approve-once", approvedInteractively: true };
    };

  // Puts the agent's ask_user form in `turn`'s chat as a question card and waits,
  // however long, for the user's answer (accept or decline). A request the card
  // cannot show (URL mode, no questions), or one outside its turn, is cancelled
  // at once, as is a question that is withdrawn.
  async function askQuestion(turn: Turn, request: QuestionRequest): Promise<ElicitationResult> {
    const form = questionForm(request);
    if (!form || !link.running(turn)) return { action: "cancel" };
    const questionId = QuestionId.parse(`question_${crypto.randomUUID()}`);
    const answered = new Promise<QuestionResult | null>((answer) =>
      asking.set(questionId, { turnId: turn.turnId, requestId: request.requestId, answer }),
    );
    link.emit(turn.turnId, { type: "question-request", questionId, form });
    const result = await answered;
    return result ? elicitationResult(form, result) : { action: "cancel" };
  }

  // The agent no longer waits on the questions that `match`: each card is
  // withdrawn in its turn (still running: it is ending, or its SDK request
  // ended), and its SDK wait ends with cancel.
  function withdrawQuestions(match: (question: { turnId: TurnId; requestId: string }) => boolean) {
    for (const [questionId, question] of asking) {
      if (!match(question)) continue;
      asking.delete(questionId);
      link.emit(question.turnId, { type: "question-withdrawn", questionId });
      question.answer(null);
    }
  }

  // A task worker's turn was cut short to renew the organization's token
  // (installationSession.ts): the permission requests its runtime waited on are
  // gone, so their approvals are withdrawn. Continuing, the agent asks again if it still needs them.
  function withdrawApprovals(turn: Turn) {
    for (const [approvalId, { answer }] of waiting) {
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
  // It works in the engineer's clone, `ready`, with the repo's instructions and
  // the project's secrets in its runtime's environment. The repo's own `mcp`
  // servers start in the clone, and their calls run unasked, like its shell's:
  // they hold no credential. A connector of the same name wins.
  function taskSession(
    options: Omit<Parameters<Copilot["openSession"]>[0], "auth">,
    { payer, connectors, setup }: Extract<ControlToWorker, { type: "run-task" }>,
    turn: Turn,
    ready: EngineerReady,
  ) {
    const connectorNames = new Set(connectors.map(({ name }) => name));
    const repoServers = Object.entries(setup.mcp).filter(([name]) => !connectorNames.has(name));
    const unasked = new Set([...connectors.flatMap(({ kind, name }) => (kind === "remote" ? [name] : [])), ...repoServers.map(([name]) => name)]);
    const askUnlessControlDoes: PermissionHandler = async (request, invocation) => {
      if (request.kind !== "mcp" || !unasked.has(request.serverName)) return options.onPermissionRequest(request, invocation);
      await agentHasScreen();
      return { kind: "approve-once" };
    };
    return link.openSession(
      copilot,
      payer.kind,
      {
        ...options,
        instructions: `${options.instructions}\n\n${ready.instructions}`,
        workingDirectory: ready.clone,
        env: setup.secrets,
        onPermissionRequest: askUnlessControlDoes,
        mcpServers: {
          ...Object.fromEntries(
            repoServers.map(([name, { command, args }]): [string, MCPServerConfig] => [name, { type: "local", command, args, workingDirectory: ready.clone, tools: ["*"] }]),
          ),
          ...connectorServers(connectors, (name) => link.connector(turn, name)),
        },
        onMcpCall: link.reportCalls(connectors, () => turn.key),
        onCut: () => withdrawApprovals(turn),
      },
      () => turn.key,
    );
  }

  // An engineer sets its computer up for its task before its agent starts
  // (engineerSetup.ts): each step goes to the turn as it ends, then setup-done.
  // Null when a step failed: the turn has ended, blocked.
  async function setUp(turn: Turn, setup: EngineerSetup) {
    const outcome = await setUpEngineer({ setup, workspace, shell: setupShell, signal: turn.ended, report: (step) => link.emit(turn.turnId, { type: "setup-step", step }) });
    if ("failed" in outcome) {
      const { command, exitCode } = outcome.failed;
      link.fail(turn.turnId, new Error(`Its setup failed: \`${command}\` exited with ${exitCode}.`));
      return null;
    }
    link.emit(turn.turnId, { type: "setup-done", ...outcome.found });
    return outcome;
  }

  // Opens the computer's Copilot session for `turn` (resuming its conversation:
  // its id is the bot's, or task worker's), in place of the open one. Every
  // callback in it holds that turn, so a late one acts in no other. A bot's
  // session for no turn lists its models when the worker binds; a task worker's
  // is opened by its task (`task`), once its setup is `ready`. A bot's turn's
  // session gets its staged connections (`connections`, and the skill roots they
  // are under) and asks as its `access` mode says.
  async function openSession(
    turn: Turn | null,
    task?: { message: Extract<ControlToWorker, { type: "run-task" }>; ready: EngineerReady },
    {
      connections,
      skillDirectories,
      access,
    }: { connections: AgentConnection[]; skillDirectories: string[]; access: AccessMode } = { connections: [], skillDirectories: [], access: DEFAULT_ACCESS },
  ) {
    const previous = open;
    open = null;
    await (await previous?.session.catch(() => null))?.disconnect();
    // A task worker does one task for a project: it is no one's chief of staff.
    const turnKey = keyOf(turn);
    const tools = [
      pullRequestTool({ base, turnKey, ...(task ? { holdsSecret: secretRedactor(Object.values(task.message.setup.secrets)).holds } : {}) }),
      computerTool({
        run: screenCommands,
        agentHasScreen: () => screenControl === "agent",
        // A session for no turn runs no computer call.
        turnEnded: turn?.ended ?? AbortSignal.abort(),
        screenshotDir: join(connectionsRoot, "screen"),
      }),
      ...(route === "worker" ? chiefTools({ controlUrl, botId: id, turnKey }) : []),
    ];
    const options = {
      sessionId: id,
      onPermissionRequest: permissionFor(turn, connections, access),
      tools,
      instructions: computerInstructions,
      skillDirectories: [...skillDirectories, ...(task?.ready.skillDirectories ?? [])],
    };
    // Only a bot's turn asks its user questions; a task worker's runs alone. Once
    // the SDK says a request is resolved (elicitation.completed), its card goes,
    // unless answered: `ended` hears it from before the session opens.
    const questions: Questions | null =
      route === "worker" && turn
        ? { ask: (request) => askQuestion(turn, request), ended: (requestId) => withdrawQuestions((question) => question.requestId === requestId) }
        : null;
    const asks = questions ? { questions } : {};
    // A chief always runs on its owner's own Copilot seat.
    const session = (task && turn ? taskSession(options, task.message, turn, task.ready) : link.openSession(copilot, "seat", { ...options, ...asks }, () => token)).then(
      (opened) => {
        if (turn) opened.on((event: SessionEvent) => link.sessionEvent(turn, event));
        return opened;
      },
    );
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

  // Saves the files sent with `turn`'s message in <attachmentsRoot>/<turn id>/,
  // each read from control with the turn's key, as the session's attachments.
  async function saveAttachments(turn: Turn, attachments: SentAttachment[]): Promise<FileAttachment[]> {
    return Promise.all(
      attachments.map(async ({ id, name }) => {
        const res = await fetch(`${base}/attachments/${id}`, { headers: { authorization: `Bearer ${turn.key}` } });
        if (!res.ok) throw new Error(`Could not read ${name} from control (${res.status}).`);
        const path = join(attachmentsRoot, turn.turnId, name);
        await Bun.write(path, res);
        return { type: "file" as const, path, displayName: name };
      }),
    );
  }

  // Control sends a turn only once the previous one is done. Each turn opens its
  // session (above), with the bot's model and its reasoning `effort` set first
  // (the SDK changes both on an open session, so switching mid-conversation keeps
  // the history; a null effort clears the last one). A task worker's one turn
  // (`task`) sets up first, then runs on the default model, in the default access
  // mode. Git's credential helper hands git this turn's key from now on (the
  // setup's clone too). A bot's turn stages its owner's `connections` until it
  // ends, asks as its `access` mode says, and sends its message with the
  // `attachments` sent with it.
  async function runTurn(
    turnId: TurnId,
    turnKey: TurnKey,
    text: string,
    model: string | null,
    {
      task,
      connections = [],
      effort = null,
      access = DEFAULT_ACCESS,
      attachments = [],
    }: {
      task?: Extract<ControlToWorker, { type: "run-task" }>;
      connections?: AgentConnection[];
      effort?: ReasoningEffort | null;
      access?: AccessMode;
      attachments?: SentAttachment[];
    } = {},
  ) {
    // An engineer's events hide its project's secrets before they leave the computer.
    const turn = link.begin(turnId, turnKey, task ? turnEventRedactor(secretRedactor(Object.values(task.setup.secrets))) : undefined);
    git?.reload({ fetch: gitCredential(turn) });
    try {
      staged = { ...stageConnections(connectionsRoot, connections), turnId };
      const { skillDirectories } = staged;
      const ready = task ? await setUp(turn, task.setup) : null;
      if (task && !ready) return;
      const opened = await openSession(turn, task && ready ? { message: task, ready } : undefined, { connections, skillDirectories, access });
      if (model !== null) await opened.setModel(model, effort);
      await opened.send(text, await saveAttachments(turn, attachments));
    } catch (error) {
      link.fail(turnId, error);
    }
  }

  const link = controlLink({
    base,
    token,
    retryMs,
    capabilities: [ACCESS_MODES, ATTACHMENTS, ENGINEER_SETUP],
    ...(clock === undefined ? {} : { clock }),
    parse: (json) => ControlToWorker.parse(json),
    // Called synchronously just before the turn's done goes out, so nothing can
    // run in between: its approvals still waiting are refused, the runs of its
    // connections' CLIs go to control in one message ahead of the done (read
    // once, bounded, never throwing: connections.ts), and its connections go.
    // Its questions still waiting are withdrawn, ahead of the done. An
    // engineer's session closes with its one turn, and the runtime holding the
    // project's secrets with it.
    onTurnEnd(turnId) {
      for (const [approvalId, waiter] of waiting) {
        if (waiter.turnId !== turnId) continue;
        waiting.delete(approvalId);
        waiter.answer(null);
      }
      withdrawQuestions((question) => question.turnId === turnId);
      if (route === "task-worker" && open?.turn?.turnId === turnId) {
        const closing = open.session;
        open = null;
        void closing.then((session) => session.disconnect()).catch(() => {});
      }
      if (staged?.turnId !== turnId) return;
      try {
        const calls = staged.calls();
        if (calls.length > 0) link.send({ type: "connection-calls", turnId, calls });
      } finally {
        staged.cleanup();
        staged = null;
      }
    },
    onMessage(message) {
      switch (message.type) {
        case "bound":
          onBound?.();
          // A task worker's session waits for its task, which names its payer; it has no model picker.
          if (route === "worker") void reportModels();
          break;
        case "run-turn":
          void runTurn(message.turnId, message.turnKey, message.text, message.model, {
            connections: message.connections,
            effort: message.effort,
            access: message.access,
            attachments: message.attachments,
          });
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
          waiting.get(message.approvalId)?.answer(message.approved);
          waiting.delete(message.approvalId);
          break;
        case "question-answer":
          asking.get(message.questionId)?.answer(message.result);
          asking.delete(message.questionId);
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
    // Also on SIGTERM (index.ts): approvals still waiting are refused, questions
    // cancelled and the staged connections removed, so a stopped computer keeps
    // no credential. Control ends their turn: their cards expire.
    stop() {
      for (const { answer } of waiting.values()) answer(null);
      waiting.clear();
      for (const { answer } of asking.values()) answer(null);
      asking.clear();
      stageConnections(connectionsRoot, []);
      staged = null;
      link.stop();
      for (const close of streams) close();
      git?.stop(true);
      if (gitSocket) rmSync(gitSocket, { force: true });
    },
  };
}
