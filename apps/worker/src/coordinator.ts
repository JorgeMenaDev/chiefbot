import type { PermissionHandler } from "@github/copilot-sdk";
import {
  ControlToCoordinator,
  type AgentConnector,
  type CopilotPayer,
  type CoordinatorToolCall,
  type Project,
  type ProjectMember,
  type UserId,
} from "@chiefbot/contracts";
import { connectorServers } from "./connectorServers.ts";
import { controlLink, type Turn } from "./controlLink.ts";
import type { BotSession, Copilot } from "./copilot.ts";
import { coordinatorTools } from "./coordinatorTools.ts";
import { modelReport } from "./models.ts";
import { exploreAgent, readable, refreshCopy, repoSetup, repoTools, type RepoCopy } from "./repoCopy.ts";

export type CoordinatorOptions = {
  // Control's base URL as seen from the computer.
  controlUrl: string;
  // The project this computer belongs to, from CHIEFBOT_PROJECT_ID.
  projectId: string;
  // The project's credential from CHIEFBOT_PROJECT_TOKEN.
  projectToken: string;
  // The agent engine: the Copilot SDK in empty mode on a project computer, a fake in tests.
  copilot: Copilot;
  // The folder that holds the copy of the project's repo the coordinator reads (repoCopy.ts).
  repoRoot: string;
  // Wait between reconnects after the connection drops.
  retryMs?: number;
  onBound?: (project: Project) => void;
};

// A project's coordinator, on the project's computer. Dials out to control's
// /coordinator/:projectId WebSocket with the project's credential and keeps the
// connection up (controlLink.ts), resending its latest turn's events on every
// reconnect. Each member has their own chat, so their own Copilot session.
// Each turn runs on the payer control names: the member's own Copilot seat (a
// token control brokers for the turn's member), or, when the
// workspace's organization pays, an installation token control mints, on a
// runtime of the session's own, renewed when it runs low (installationSession.ts).
// Control's scheduler sends one turn at a time for the whole project, on the
// project's model. The coordinator plans, tracks and dispatches work: its tools
// are the task ledger, the shared context and the project's workers, all kept by
// control, plus the project's connectors that control sends with each turn,
// which act as the member whoever pays for Copilot. It reads the repo too: a
// copy of its default branch that each turn fetches (repoCopy.ts), with its
// instructions and skills, and through an explore helper in its session.
// No shell, and it writes no files. Every call a member's
// session makes to control carries the key of the turn it was opened for. A
// member who leaves the workspace has their turn dropped and their session stopped.
export function startCoordinator({ controlUrl, projectId, projectToken, copilot, repoRoot, retryMs = 2000, onBound }: CoordinatorOptions) {
  const base = `${controlUrl}/coordinator/${projectId}`;
  let project: Project | null = null;
  // Each member's session of their latest turn, and that turn. A session is
  // opened (resumed, keeping its history) for every turn, so every callback in it
  // holds that turn and its key: a late one from an earlier turn acts in no
  // other. `unsubscribe` stops its events reaching the chat.
  const sessions = new Map<UserId, { turn: Turn; session: Promise<BotSession>; unsubscribe: () => void }>();
  // Each member's latest turn, from its start: a member who leaves has it
  // dropped even before it has a session, while it fetches.
  const turns = new Map<UserId, Turn>();
  // The copy's refreshes run one at a time, each turn's after the one before,
  // even one control ended (whose fetch that end stops): no refresh changes the
  // copy under another turn, or removes it after the next turn fetched it.
  let refreshing: Promise<unknown> = Promise.resolve();
  const refresh = (turn: Turn, url: string) => {
    const refreshed = refreshing.then((): Promise<RepoCopy> | RepoCopy =>
      turn.ended.aborted ? { error: "The turn ended." } : refreshCopy(repoRoot, url, turn.key, turn.ended),
    );
    // A refresh that fails outright (its cleanup failed) still lets the next one run.
    refreshing = refreshed.catch(() => {});
    return refreshed;
  };

  // Only the coordinator's own tools and its session's connectors run; the
  // empty-mode runtime offers no others anyway, but its skill tool. That may read
  // a skill's files, so the runtime may read inside the turn's `copy`, and nowhere else.
  const permissionFor =
    (toolNames: Set<string>, connectors: AgentConnector[], copy: RepoCopy): PermissionHandler =>
    async (request) =>
      (request.kind === "custom-tool" && toolNames.has(request.toolName)) ||
      (request.kind === "mcp" && connectors.some(({ name }) => name === request.serverName)) ||
      (request.kind === "read" && (await readable(copy, request.path)))
        ? { kind: "approve-once" }
        : { kind: "reject", feedback: "The coordinator can only use its task, context, worker and repo tools and the project's connectors." };

  // Stops the session's events reaching the chat and closes it (an
  // organization's runtime stops with it), cutting its running turn short first when `abort`.
  async function close(open: { session: Promise<BotSession>; unsubscribe: () => void }, abort: boolean) {
    open.unsubscribe();
    const session = await open.session.catch(() => null);
    if (abort) await session?.abort();
    await session?.disconnect();
  }

  // The member's session for `turn`, in place of the one of their previous turn,
  // or null when control ended the turn first. Its repo tools come from `copy`,
  // the repo as this turn fetched it, and the repo's instructions and skills from its `setup`.
  async function sessionFor(member: ProjectMember, payer: CopilotPayer, connectors: AgentConnector[], turn: Turn, copy: RepoCopy, setup: Awaited<ReturnType<typeof repoSetup>>) {
    if (!project) throw new Error("A turn came before control said which project this is");
    if (!link.running(turn)) return null;
    // From here the session is in `sessions` at once, for stopMember to find.
    const previous = sessions.get(member.userId);
    sessions.delete(member.userId);
    const bearer = () => turn.key;
    const tools = [
      ...coordinatorTools(async (toolCall: CoordinatorToolCall) =>
        (await link.fromControl("/tools", turn.key, { method: "POST", body: JSON.stringify(toolCall) })).text(),
      ),
      ...repoTools(copy),
    ];
    const options = {
      sessionId: `${projectId}-${member.userId}`,
      onPermissionRequest: permissionFor(new Set(tools.map(({ name }) => name)), connectors, copy),
      tools,
      instructions: [instructions(project, member), setup.instructions].join("\n\n"),
      skillDirectories: setup.skillDirectories,
      agents: [exploreAgent],
      mcpServers: connectorServers(connectors, (name) => link.connector(turn, name)),
      onMcpCall: link.reportCalls(connectors, bearer),
    };
    // The member's own seat is brokered by control only while their turn runs.
    const opening = (previous ? close(previous, false) : Promise.resolve()).then(() => link.openSession(copilot, payer.kind, options, bearer));
    let stopEvents = () => {};
    const session = opening.then((opened) => {
      stopEvents = opened.on((event) => link.sessionEvent(turn, event));
      return opened;
    });
    sessions.set(member.userId, { turn, session, unsubscribe: () => stopEvents() });
    session.catch(() => {
      if (sessions.get(member.userId)?.session === session) sessions.delete(member.userId);
    });
    return session;
  }

  // Each turn first refreshes the copy of the repo, with the turn's key. The
  // chat shows the fetch as a tool call, so a member sees when it fails, and
  // which configured instructions or skills paths it skipped, and why. The turn
  // runs on the project's `model` at `effort`, set on the session first (the SDK
  // switches an open session's model, keeping its conversation; a null effort
  // clears the last one). The session lists its plan's models for control
  // (the member's, or the organization's when it pays), which picks the model of
  // the turns after it by them.
  async function runTurn({ turnId, turnKey, member, text, model, effort, payer, connectors }: Extract<ControlToCoordinator, { type: "run-turn" }>) {
    const turn = link.begin(turnId, turnKey);
    turns.set(member.userId, turn);
    try {
      if (!project) throw new Error("A turn came before control said which project this is");
      const { repo } = project;
      const fetchRow = (status: "running" | "succeeded" | "failed", skipped: string[] = []) => {
        if (link.running(turn)) link.emit(turnId, { type: "tool-call", toolCallId: "repo-copy", name: [`Fetch ${repo}`, ...skipped].join(" · "), status });
      };
      fetchRow("running");
      const copy = await refresh(turn, `${controlUrl}/git/${repo}.git`);
      const setup = await repoSetup(copy, project.config);
      fetchRow("error" in copy ? "failed" : "succeeded", setup.skipped);
      const session = await sessionFor(member, payer, connectors, turn, copy, setup);
      // Control ended the turn before it had a session (its member left): nothing more of it runs.
      if (!session) return;
      void session.rpc.model.list().then(
        (list) => link.send({ type: "models", turnId, report: modelReport(list) }),
        () => {},
      );
      await session.setModel(model, effort);
      await session.send(text);
    } catch (error) {
      link.fail(turnId, error);
    }
  }

  // The member left the workspace: their turn is dropped (a fetch it runs
  // stops), and their session stops now and closes (an organization's runtime
  // stops with it). Control ended their turn already.
  async function stopMember(userId: UserId) {
    const turn = turns.get(userId);
    turns.delete(userId);
    if (turn) link.drop(turn);
    const open = sessions.get(userId);
    sessions.delete(userId);
    if (open) await close(open, true);
  }

  const link = controlLink({
    base,
    token: projectToken,
    retryMs,
    parse: (json) => ControlToCoordinator.parse(json),
    onMessage(message) {
      switch (message.type) {
        case "bound":
          project = message.project;
          onBound?.(message.project);
          break;
        case "run-turn":
          void runTurn(message);
          break;
        case "turn-key":
          link.rekey(message.turnId, message.turnKey);
          break;
        case "member-removed":
          void stopMember(message.userId);
          break;
      }
    },
  });

  return { stop: link.stop };
}

// What the coordinator is told about its job, the project and who it talks with.
function instructions({ name, repo, config }: Project, member: ProjectMember) {
  const commands = Object.entries(config.commands).map(([command, line]) => `- ${command}: ${line}`);
  return [
    `You are the coordinator of the project ${name} (GitHub repo ${repo}). You plan and track its work; you never write code yourself.`,
    `You are talking with ${member.login}, a member of the project. Every member has their own chat with you, and all of them share one task ledger and one set of context files.`,
    "The task ledger is the only record of what is being done. Before you create a task, call list_tasks: when a task already covers the request, whoever asked for it, tell the member and update that task instead of creating another.",
    "Keep lasting knowledge in the context files: notes.md for current status, docs/ for lasting context, plans/ for plans.",
    "To get a task done, dispatch an engineer with dispatch_worker: a fresh computer that clones the repo, runs its setup and does the task on the Copilot seat of the member you are talking with, who approves its push and pull request. It ends in a draft pull request, linked on the task, or in a report when nothing needs to change. Dispatching returns at once: check on it with worker_status and worker_transcript, and stop it with stop_worker.",
    "Once a task's pull request is ready, check it with dispatch_verifier: a verifier, a fresh computer that checks the pull request at its head as a person would, ending with a verdict on the task: pass, issues or blocked. On issues, dispatch an engineer to fix them, then a verifier again.",
    `The project runs at most ${config.workers.max} ${config.workers.max === 1 ? "worker" : "workers"} at once, engineers and verifiers together: another dispatch is queued and starts when one ends. A task has one worker at a time. A worker whose setup fails is blocked: its transcript has the setup's log.`,
    "Mark a task with a pull request done only once a verifier's pass is for the pull request's head: control refuses it otherwise, and a new push makes a pass stale. Mark a task abandoned when it is dropped. Either removes its workers' computers.",
    "When a task waits on a person, set it to needs_input with question: the one specific thing they must answer. A message that starts \"About task #N\" is a follow-up or an answer for that task: work it into that task, never into a new one.",
    ...(commands.length > 0 ? ["The repo's commands:", ...commands] : []),
  ].join("\n");
}
