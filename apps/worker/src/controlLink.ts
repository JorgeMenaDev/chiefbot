import type { SessionEvent } from "@github/copilot-sdk";
import {
  ApiError,
  BrokeredGitHubToken,
  BrokerRefusal,
  CopilotInstallationToken,
  type AgentConnector,
  type CopilotPayer,
  type ReportedConnectorCall,
  type TurnEvent,
  type TurnId,
  type WorkerToControl,
} from "@chiefbot/contracts";
import type { BotSession, Copilot } from "./copilot.ts";
import { installationSession } from "./installationSession.ts";
import { newTurnStream, toTurnEvents, type TurnStream } from "./turnEvents.ts";

// The link an agent runtime in a computer keeps to control: a bot's or task
// worker's (worker.ts) or a project's coordinator (coordinator.ts). Both speak
// the same protocol on their own routes under `base` (control's /worker/:id,
// /task-worker/:id or /coordinator/:projectId), with the computer's credential.
//
// It dials control's WebSocket and keeps it up: a drop or a control restart ends
// in a reconnect after `retryMs`. It runs one turn at a time: the runtime
// `begin`s a turn, streams its SDK session's events through `sessionEvent` (as
// numbered TurnEvents), and a turn ends with `done`. Every event of the latest
// turn is resent on each reconnect, then a hello names the turn still running
// (control stores each event once). Its HTTP calls throw with control's reason
// when control refuses.
export function controlLink<Message>({
  base,
  token,
  retryMs,
  parse,
  onMessage,
}: {
  base: string;
  token: string;
  retryMs: number;
  // Reads one message from control's WebSocket.
  parse: (json: unknown) => Message;
  onMessage: (message: Message) => void;
}) {
  const auth = { authorization: `Bearer ${token}` };
  let socket: WebSocket | null = null;
  let retry: Timer | null = null;
  let stopped = false;
  // Every event of the latest turn, numbered by position.
  let latest: { turnId: TurnId; events: TurnEvent[] } | null = null;
  // The turn running now, and what it has streamed so far.
  let active: ({ turnId: TurnId } & TurnStream) | null = null;

  // Turn events and hellos: what a bot's worker and a coordinator both send.
  function send(message: WorkerToControl) {
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
    const body: unknown = await res.json().catch(() => null);
    if (BrokerRefusal.safeParse(body).success) throw new Error("Chiefbot has lost your GitHub sign-in. Sign in again in the Chiefbot app, then resend.");
    const refusal = ApiError.safeParse(body);
    throw new Error(refusal.success ? (refusal.data.message ?? refusal.data.error) : `Control answered ${res.status}`);
  }

  // A seat's short-lived GitHub access token for the SDK, from control's broker at
  // `path`. The computer keeps no token: the SDK asks again when one has an hour or less left.
  async function seatToken(path: string) {
    const { accessToken, expiresAt } = BrokeredGitHubToken.parse(await (await fromControl(path)).json());
    return { kind: "token" as const, accessToken, expiresIn: Math.floor((expiresAt - Date.now()) / 1000) };
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
    socket.onmessage = (event) => onMessage(parse(JSON.parse(String(event.data))));
    socket.onclose = () => {
      if (!stopped) retry = setTimeout(connect, retryMs);
    };
  }
  connect();

  return {
    send,
    emit,
    fromControl,

    // The turn running now, or null.
    activeTurnId: () => active?.turnId ?? null,

    // The runtime starts `turnId`: the session's events stream into it from now on.
    begin(turnId: TurnId) {
      active = { turnId, ...newTurnStream() };
    },

    // Maps one SDK session event to the running turn's TurnEvents. Sub-agent
    // events (agentId set) are left out: the chat shows the main agent's work.
    sessionEvent(event: SessionEvent) {
      if (!active || event.agentId) return;
      const { turnId } = active;
      for (const turnEvent of toTurnEvents(event, active)) emit(turnId, turnEvent);
    },

    // The turn failed outside the session's own events: an error, then done.
    fail(turnId: TurnId, error: unknown) {
      emit(turnId, { type: "error", message: error instanceof Error ? error.message : String(error) });
      emit(turnId, { type: "done" });
    },

    // Opens a session on `payer`'s Copilot: a seat's, with tokens from control's
    // broker at `seatPath`, or the organization's, on installation tokens control
    // mints, on a runtime of its own (installationSession.ts).
    openSession(copilot: Copilot, payer: CopilotPayer["kind"], options: Omit<Parameters<Copilot["openSession"]>[0], "auth">, seatPath: string): Promise<BotSession> {
      return payer === "org"
        ? installationSession({ ...options, copilot, token: async () => CopilotInstallationToken.parse(await (await fromControl("/installation-token")).json()) })
        : copilot.openSession({ ...options, auth: { kind: "seat", gitHubTokenProvider: () => seatToken(seatPath) } });
    },

    // Control logs remote connectors' calls in its proxy; a command connector's
    // call runs in the computer, so it is reported. A failed report does not stop the call.
    reportCalls: (connectors: AgentConnector[]) => async (serverName: string, toolName: string) => {
      if (!connectors.some(({ name, kind }) => name === serverName && kind === "command")) return;
      const call: ReportedConnectorCall = { connector: serverName, tool: toolName };
      await fromControl("/connector-calls", { method: "POST", body: JSON.stringify(call) }).catch(() => {});
    },

    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    },
  };
}
