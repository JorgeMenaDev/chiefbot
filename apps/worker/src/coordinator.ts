import type { PermissionHandler, SessionEvent } from "@github/copilot-sdk";
import {
  ControlToCoordinator,
  type AgentConnector,
  type CopilotPayer,
  type CoordinatorToolCall,
  type Project,
  type ProjectMember,
  type TurnId,
  type TurnKey,
  type UserId,
} from "@chiefbot/contracts";
import { connectorServers } from "./connectorServers.ts";
import { controlLink } from "./controlLink.ts";
import type { BotSession, Copilot } from "./copilot.ts";
import { coordinatorTools } from "./coordinatorTools.ts";

export type CoordinatorOptions = {
  // Control's base URL as seen from the computer.
  controlUrl: string;
  // The project this computer belongs to, from CHIEFBOT_PROJECT_ID.
  projectId: string;
  // The project's credential from CHIEFBOT_PROJECT_TOKEN.
  projectToken: string;
  // The agent engine: the Copilot SDK in empty mode on a project computer, a fake in tests.
  copilot: Copilot;
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
// workspace's organization pays, an installation token control mints, which
// the session's own runtime is restarted on when it runs low (installationSession.ts).
// Control's scheduler sends one turn at a time for the whole project. The
// coordinator plans, tracks and dispatches work: its tools are the task ledger,
// the shared context and the project's workers, all kept by control, plus the
// project's connectors that control sends with each turn, which act as the
// member whoever pays for Copilot. No shell, no files. Every call a member's
// session makes to control carries the key of that member's running turn, and
// none is made outside it. A member who leaves the workspace has their session stopped.
export function startCoordinator({ controlUrl, projectId, projectToken, copilot, retryMs = 2000, onBound }: CoordinatorOptions) {
  const base = `${controlUrl}/coordinator/${projectId}`;
  let project: Project | null = null;
  // The member whose turn is running: only their session's events reach the chat.
  let activeMember: UserId | null = null;
  // Each member's session, opened by their first turn and opened again (resumed,
  // keeping its history) when their connectors or the kind of payer change.
  // `key` identifies both; `unsubscribe` stops its events reaching the chat.
  const sessions = new Map<UserId, { key: string; session: Promise<BotSession>; unsubscribe: () => void }>();

  // The running turn's key, for a call of the member's session: only in their own turn.
  const keyOf = (userId: UserId) => {
    if (activeMember !== userId) throw new Error("This member's turn is not running, so Chiefbot refuses this call.");
    return link.turnKey();
  };

  // Only the coordinator's own tools and its session's connectors run; the
  // empty-mode runtime offers no others anyway.
  const permissionFor =
    (toolNames: Set<string>, connectors: AgentConnector[]): PermissionHandler =>
    async (request) =>
      (request.kind === "custom-tool" && toolNames.has(request.toolName)) ||
      (request.kind === "mcp" && connectors.some(({ name }) => name === request.serverName))
        ? { kind: "approve-once" }
        : { kind: "reject", feedback: "The coordinator can only use its task, context and worker tools and the project's connectors." };

  async function sessionFor(member: ProjectMember, payer: CopilotPayer, connectors: AgentConnector[], turnKey: TurnKey) {
    // A remote connector's server config carries the turn's key, so a session
    // with one opens again (resumed) for each turn.
    const remote = connectors.some(({ kind }) => kind === "remote");
    const key = JSON.stringify({ payer: payer.kind, connectors, turnKey: remote ? turnKey : null });
    const open = sessions.get(member.userId);
    if (open?.key === key) return open.session;
    if (!project) throw new Error("A turn came before control said which project this is");
    // The replaced session sends nothing more to the chat, and closes: an
    // organization's runtime stops with it.
    if (open) {
      const replaced = await open.session.catch(() => null);
      open.unsubscribe();
      await replaced?.disconnect();
    }
    const bearer = () => keyOf(member.userId);
    const tools = coordinatorTools(async (toolCall: CoordinatorToolCall) =>
      (await link.fromControl("/tools", bearer(), { method: "POST", body: JSON.stringify(toolCall) })).text(),
    );
    const options = {
      sessionId: `${projectId}-${member.userId}`,
      onPermissionRequest: permissionFor(new Set(tools.map(({ name }) => name)), connectors),
      tools,
      instructions: instructions(project, member),
      mcpServers: connectorServers(connectors, { base, credential: turnKey }),
      onMcpCall: link.reportCalls(connectors, bearer),
    };
    // The member's own seat is brokered by control only while their turn runs.
    const opening = link.openSession(copilot, payer.kind, options, bearer);
    let stopEvents = () => {};
    const session = opening.then((opened) => {
      stopEvents = opened.on((event) => onSessionEvent(member.userId, event));
      return opened;
    });
    sessions.set(member.userId, { key, session, unsubscribe: () => stopEvents() });
    session.catch(() => {
      if (sessions.get(member.userId)?.session === session) sessions.delete(member.userId);
    });
    return session;
  }

  function onSessionEvent(userId: UserId, event: SessionEvent) {
    if (activeMember === userId) link.sessionEvent(event);
  }

  async function runTurn({ turnId, turnKey, member, text, payer, connectors }: Extract<ControlToCoordinator, { type: "run-turn" }>) {
    link.begin(turnId, turnKey);
    activeMember = member.userId;
    try {
      await (await sessionFor(member, payer, connectors, turnKey)).send(text);
    } catch (error) {
      link.fail(turnId, error);
    }
  }

  // The member left the workspace: their session stops now, and closes (an
  // organization's runtime stops with it). Control ended their turn already.
  async function stopMember(userId: UserId) {
    if (activeMember === userId) activeMember = null;
    const open = sessions.get(userId);
    sessions.delete(userId);
    if (!open) return;
    open.unsubscribe();
    const session = await open.session.catch(() => null);
    await session?.abort();
    await session?.disconnect();
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
function instructions({ name, repo, file }: Project, member: ProjectMember) {
  const commands = Object.entries(file.commands).map(([command, line]) => `- ${command}: ${line}`);
  return [
    `You are the coordinator of the project ${name} (GitHub repo ${repo}). You plan and track its work; you never write code yourself.`,
    `You are talking with ${member.login}, a member of the project. Every member has their own chat with you, and all of them share one task ledger and one set of context files.`,
    "The task ledger is the only record of what is being done. Before you create a task, call list_tasks: when a task already covers the request, whoever asked for it, tell the member and update that task instead of creating another.",
    "Keep lasting knowledge in the context files: notes.md for current status, docs/ for lasting context, plans/ for plans.",
    "To get a task done, dispatch a worker with dispatch_worker: a fresh computer that clones the repo, does the task and opens a pull request, on the Copilot seat of the member you are talking with, who approves its push and pull request. Dispatching returns at once: check on it with worker_status and worker_transcript, and stop it with stop_worker. Its pull request is linked on the task.",
    "Mark a task done once its pull request is accepted, or abandoned when it is dropped: that removes its workers' computers.",
    ...(commands.length > 0 ? ["The repo's commands:", ...commands] : []),
  ].join("\n");
}
