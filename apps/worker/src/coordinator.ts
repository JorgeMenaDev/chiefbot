import type { PermissionHandler, SessionEvent } from "@github/copilot-sdk";
import {
  ApiError,
  BrokeredGitHubToken,
  ControlToCoordinator,
  CopilotInstallationToken,
  type AgentConnector,
  type CoordinatorToControl,
  type CopilotPayer,
  type CoordinatorToolCall,
  type ReportedConnectorCall,
  type Project,
  type ProjectMember,
  type TurnEvent,
  type TurnId,
  type UserId,
} from "@chiefbot/contracts";
import { connectorServers } from "./connectorServers.ts";
import type { BotSession, Copilot } from "./copilot.ts";
import { coordinatorTools } from "./coordinatorTools.ts";
import { installationSession } from "./installationSession.ts";
import { newTurnStream, toTurnEvents, type TurnStream } from "./turnEvents.ts";

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
// connection up. Each member has their own chat, so their own Copilot session.
// Each turn runs on the payer control names: the member's own Copilot seat (a
// token control brokers for the member whose turn is running), or, when the
// workspace's organization pays, an installation token control mints, which
// the session's own runtime is restarted on when it runs low (installationSession.ts).
// Control's scheduler sends one turn at a time for the whole project. The
// coordinator plans and tracks work: its tools are the task ledger and the
// shared context, both kept by control, plus the project's connectors that
// control sends with each turn, which act as the member whoever pays for
// Copilot. No shell, no files.
// Like a bot's worker, it resends its latest turn's events on every reconnect.
export function startCoordinator({ controlUrl, projectId, projectToken, copilot, retryMs = 2000, onBound }: CoordinatorOptions) {
  const base = `${controlUrl}/coordinator/${projectId}`;
  const auth = { authorization: `Bearer ${projectToken}` };
  let socket: WebSocket | null = null;
  let retry: Timer | null = null;
  let stopped = false;
  let project: Project | null = null;
  // Every event of the latest turn, numbered by position.
  let latest: { turnId: TurnId; events: TurnEvent[] } | null = null;
  // The turn running now, whose chat it is, and what it has streamed so far.
  let active: ({ turnId: TurnId; userId: UserId } & TurnStream) | null = null;
  // Each member's session, opened by their first turn and opened again (resumed,
  // keeping its history) when their connectors or the kind of payer change.
  // `key` identifies both; `unsubscribe` stops its events reaching the chat.
  const sessions = new Map<UserId, { key: string; session: Promise<BotSession>; unsubscribe: () => void }>();

  function send(message: CoordinatorToControl) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function emit(turnId: TurnId, event: TurnEvent) {
    if (latest?.turnId !== turnId) latest = { turnId, events: [] };
    latest.events.push(event);
    send({ type: "turn-event", turnId, index: latest.events.length - 1, event });
    if (event.type === "done" && active?.turnId === turnId) active = null;
  }

  // Throws with control's reason when it refuses.
  async function fromControl(path: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...auth, "content-type": "application/json" } });
    if (res.ok) return res;
    const refusal = ApiError.safeParse(await res.json().catch(() => null));
    throw new Error(refusal.success ? (refusal.data.message ?? refusal.data.error) : `Control answered ${res.status}`);
  }

  const tools = coordinatorTools(async (toolCall: CoordinatorToolCall) =>
    (await fromControl("/tools", { method: "POST", body: JSON.stringify(toolCall) })).text(),
  );
  const toolNames = new Set<string>(tools.map(({ name }) => name));

  // Only the coordinator's own tools and its session's connectors run; the
  // empty-mode runtime offers no others anyway.
  const permissionFor =
    (connectors: AgentConnector[]): PermissionHandler =>
    async (request) =>
      (request.kind === "custom-tool" && toolNames.has(request.toolName)) ||
      (request.kind === "mcp" && connectors.some(({ name }) => name === request.serverName))
        ? { kind: "approve-once" }
        : { kind: "reject", feedback: "The coordinator can only use its task and context tools and the project's connectors." };

  // Control logs remote connectors' calls in its proxy; a command connector's
  // call runs here, so it is reported. A failed report does not stop the call.
  const reportCall = (connectors: AgentConnector[]) => async (serverName: string, toolName: string) => {
    if (!connectors.some(({ name, kind }) => name === serverName && kind === "command")) return;
    const call: ReportedConnectorCall = { connector: serverName, tool: toolName };
    await fromControl("/connector-calls", { method: "POST", body: JSON.stringify(call) }).catch(() => {});
  };

  async function sessionFor(member: ProjectMember, payer: CopilotPayer, connectors: AgentConnector[]) {
    const key = JSON.stringify({ payer: payer.kind, connectors });
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
    const options = {
      sessionId: `${projectId}-${member.userId}`,
      onPermissionRequest: permissionFor(connectors),
      tools,
      instructions: instructions(project, member),
      mcpServers: connectorServers(connectors, { base, credential: projectToken, member: member.userId }),
      onMcpCall: reportCall(connectors),
    };
    const opening =
      payer.kind === "org"
        ? // The organization's Copilot, on installation tokens control mints for the running turn.
          installationSession({
            ...options,
            copilot,
            token: async () => CopilotInstallationToken.parse(await (await fromControl("/installation-token")).json()),
          })
        : copilot.openSession({
            ...options,
            // The member's own Copilot seat, brokered by control while their turn runs.
            auth: {
              kind: "seat",
              gitHubTokenProvider: async () => {
                const { accessToken, expiresAt } = BrokeredGitHubToken.parse(await (await fromControl(`/github-token/${member.userId}`)).json());
                return { kind: "token" as const, accessToken, expiresIn: Math.floor((expiresAt - Date.now()) / 1000) };
              },
            },
          });
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

  // Sub-agent events (agentId set) are left out: the chat shows the coordinator's own work.
  function onSessionEvent(userId: UserId, event: SessionEvent) {
    if (!active || active.userId !== userId || event.agentId) return;
    const { turnId } = active;
    for (const turnEvent of toTurnEvents(event, active)) emit(turnId, turnEvent);
  }

  async function runTurn(turnId: TurnId, member: ProjectMember, text: string, payer: CopilotPayer, connectors: AgentConnector[]) {
    active = { turnId, userId: member.userId, ...newTurnStream() };
    try {
      await (await sessionFor(member, payer, connectors)).send(text);
    } catch (error) {
      emit(turnId, { type: "error", message: error instanceof Error ? error.message : String(error) });
      emit(turnId, { type: "done" });
    }
  }

  function connect() {
    socket = new WebSocket(base.replace(/^http/, "ws"), { headers: auth });
    socket.onopen = () => {
      if (latest) {
        const { turnId, events } = latest;
        events.forEach((event, index) => send({ type: "turn-event", turnId, index, event }));
      }
      send({ type: "hello", activeTurnId: active?.turnId ?? null });
    };
    socket.onmessage = (event) => {
      const message = ControlToCoordinator.parse(JSON.parse(String(event.data)));
      if (message.type === "bound") {
        project = message.project;
        onBound?.(message.project);
      } else void runTurn(message.turnId, message.member, message.text, message.payer, message.connectors);
    };
    socket.onclose = () => {
      if (!stopped) retry = setTimeout(connect, retryMs);
    };
  }
  connect();

  return {
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    },
  };
}

// What the coordinator is told about its job, the project and who it talks with.
function instructions({ name, repo, file }: Project, member: ProjectMember) {
  const commands = Object.entries(file.commands).map(([command, line]) => `- ${command}: ${line}`);
  return [
    `You are the coordinator of the project ${name} (GitHub repo ${repo}). You plan and track its work; you never write code yourself.`,
    `You are talking with ${member.login}, a member of the project. Every member has their own chat with you, and all of them share one task ledger and one set of context files.`,
    "The task ledger is the only record of what is being done. Before you create a task, call list_tasks: when a task already covers the request, whoever asked for it, tell the member and update that task instead of creating another.",
    "Keep lasting knowledge in the context files: notes.md for current status, docs/ for lasting context, plans/ for plans.",
    ...(commands.length > 0 ? ["The repo's commands:", ...commands] : []),
  ].join("\n");
}
