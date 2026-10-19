import type { SessionEvent } from "@github/copilot-sdk";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
  type TurnKey,
  type WorkerToControl,
} from "@chiefbot/contracts";
import { systemClock, type Clock } from "./clock.ts";
import type { BotSession, Copilot } from "./copilot.ts";
import { installationSession, renewWithinMs } from "./installationSession.ts";
import { newTurnStream, toTurnEvents, type TurnStream } from "./turnEvents.ts";

// One turn of the runtime as control gave it: its id and its key. Whatever acts
// in the turn holds this object from the turn's start, never "the turn running
// now", and reads `key` when it calls control: only control's turn-key message
// for this same turn changes it.
export type Turn = { readonly turnId: TurnId; key: TurnKey };

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
// (control stores each event once). Each turn comes with its key (contracts
// ids.ts TurnKey), the bearer of every call to control in it; the computer's
// credential is only for the WebSocket (and a bot's own model listing). Its HTTP
// calls throw with control's reason when control refuses. A session reaches its
// remote connectors through this link's forwarder on the computer's loopback,
// with its turn's private forwarder secret; the forwarder adds the turn's key to
// each request as it goes out.
export function controlLink<Message>({
  base,
  token,
  retryMs,
  clock,
  parse,
  onMessage,
  onTurnEnd,
}: {
  base: string;
  token: string;
  retryMs: number;
  // Times an organization's token renewals. Default: the system clock.
  clock?: Clock;
  // Reads one message from control's WebSocket.
  parse: (json: unknown) => Message;
  onMessage: (message: Message) => void;
  // A turn is ending: called just before its `done` goes to control.
  onTurnEnd?: (turnId: TurnId) => void;
}) {
  const auth = { authorization: `Bearer ${token}` };
  let socket: WebSocket | null = null;
  let retry: Timer | null = null;
  let stopped = false;
  // Every event of the latest turn, numbered by position.
  let latest: { turnId: TurnId; events: TurnEvent[] } | null = null;
  // The turn running now, its forwarder secret, and what it has streamed so far:
  // where session events go, and the only turn the connector forwarder serves.
  // The secret (32 random bytes) is the turn's alone and is forgotten with it.
  let active: ({ turn: Turn; secret: string } & TurnStream) | null = null;
  // The connector forwarder, started by the first connector URL.
  let forwarder: Bun.Server<undefined> | null = null;
  // The organization's latest installation token: each turn's runtime starts on
  // it while it has time left for a turn, so a turn costs no new token.
  let orgToken: CopilotInstallationToken | null = null;

  // Turn events and hellos: what a bot's worker and a coordinator both send.
  function send(message: WorkerToControl) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function emit(turnId: TurnId, event: TurnEvent) {
    if (event.type === "done") onTurnEnd?.(turnId);
    if (latest?.turnId !== turnId) latest = { turnId, events: [] };
    latest.events.push(event);
    send({ type: "turn-event", turnId, index: latest.events.length - 1, event });
    if (event.type === "done" && active?.turn.turnId === turnId) active = null;
  }

  // Forwards /mcp/:name to control's proxy for that connector, for the running
  // turn whose secret is the request's bearer (401 for anything else, which
  // never reaches control). The turn's key is read once the body is in, so a
  // rekey during the upload applies.
  async function forward(req: Request, server: Bun.Server<undefined>) {
    const serving = active;
    if (!serving || !sameSecret(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "", serving.secret)) {
      return Response.json({ error: "unauthorized" } satisfies ApiError, { status: 401 });
    }
    const [, name] = new URL(req.url).pathname.match(/^\/mcp\/([^/]+)$/) ?? [];
    if (!name) return Response.json({ error: "not_found" } satisfies ApiError, { status: 404 });
    server.timeout(req, 0);
    const body = req.method === "POST" ? await req.arrayBuffer() : null;
    if (active !== serving) return Response.json({ error: "invalid_turn_key", message: "This turn has ended." } satisfies ApiError, { status: 403 });
    const headers = pick(req.headers, ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]);
    headers.set("authorization", `Bearer ${serving.turn.key}`);
    const upstream = await fetch(`${base}/mcp/${name}`, { method: req.method, headers, body, signal: req.signal });
    return new Response(upstream.body, { status: upstream.status, headers: pick(upstream.headers, ["content-type", "mcp-session-id"]) });
  }

  // Calls control at `path` with `bearer` (the turn's key, or the computer's
  // credential). Throws with control's reason when it refuses.
  async function fromControl(path: string, bearer: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" } });
    if (res.ok) return res;
    const body: unknown = await res.json().catch(() => null);
    if (BrokerRefusal.safeParse(body).success) throw new Error("Chiefbot has lost your GitHub sign-in. Sign in again in the Chiefbot app, then resend.");
    const refusal = ApiError.safeParse(body);
    throw new Error(refusal.success ? (refusal.data.message ?? refusal.data.error) : `Control answered ${res.status}`);
  }

  // A seat's short-lived GitHub access token for the SDK, from control's broker.
  // The computer keeps no token: the SDK asks again when one has an hour or less left.
  async function seatToken(bearer: string) {
    const { accessToken, expiresAt } = BrokeredGitHubToken.parse(await (await fromControl("/github-token", bearer)).json());
    return { kind: "token" as const, accessToken, expiresIn: Math.floor((expiresAt - Date.now()) / 1000) };
  }

  function connect() {
    socket = new WebSocket(base.replace(/^http/, "ws"), { headers: auth });
    socket.onopen = () => {
      if (latest) {
        const { turnId, events } = latest;
        events.forEach((event, index) => send({ type: "turn-event", turnId, index, event }));
      }
      send({ type: "hello", activeTurnId: active?.turn.turnId ?? null });
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

    // The runtime starts `turnId`: the turn whatever acts in it holds. Its
    // session's events stream into it from now on.
    begin(turnId: TurnId, key: TurnKey): Turn {
      const turn = { turnId, key };
      active = { turn, secret: randomBytes(32).toString("base64url"), ...newTurnStream() };
      return turn;
    },

    // Whether the turn still runs here: it has not ended, and no other turn began.
    running: (turn: Turn) => active?.turn === turn,

    // Control ended the turn itself (its member left): nothing of it streams or is forwarded any more.
    drop(turn: Turn) {
      if (active?.turn === turn) active = null;
    },

    // Control's new key for the turn (it restarted, revoking the old one).
    rekey(turnId: TurnId, key: TurnKey) {
      if (active?.turn.turnId === turnId) active.turn.key = key;
    },

    // How a session of the running `turn` reaches the remote connector `name`:
    // the forwarder's URL, and the turn's secret as the bearer.
    connector(turn: Turn, name: string) {
      if (active?.turn !== turn) throw new Error("This turn has ended.");
      forwarder ??= Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: forward });
      return { url: `${forwarder.url.origin}/mcp/${name}`, headers: { authorization: `Bearer ${active.secret}` } };
    },

    // Maps one SDK session event of `turn` to its TurnEvents, while it runs.
    // Sub-agent events (agentId set) are left out: the chat shows the main agent's work.
    sessionEvent(turn: Turn, event: SessionEvent) {
      if (active?.turn !== turn || event.agentId) return;
      for (const turnEvent of toTurnEvents(event, active)) emit(turn.turnId, turnEvent);
    },

    // The turn failed outside the session's own events: an error, then done.
    fail(turnId: TurnId, error: unknown) {
      emit(turnId, { type: "error", message: error instanceof Error ? error.message : String(error) });
      emit(turnId, { type: "done" });
    },

    // Opens a session on `payer`'s Copilot: a seat's, with tokens from control's
    // broker, or the organization's, on installation tokens control mints, on a
    // runtime of its own (installationSession.ts), whose turns may be cut short
    // for a new token (`onCut`). Each token is asked for with `bearer()`'s.
    openSession(
      copilot: Copilot,
      payer: CopilotPayer["kind"],
      { onCut, ...options }: Omit<Parameters<Copilot["openSession"]>[0], "auth"> & { onCut?: () => void },
      bearer: () => string,
    ): Promise<BotSession> {
      const token = async () => {
        if (orgToken && orgToken.expiresAt - (clock ?? systemClock).now() > renewWithinMs) return orgToken;
        orgToken = CopilotInstallationToken.parse(await (await fromControl("/installation-token", bearer())).json());
        return orgToken;
      };
      return payer === "org"
        ? installationSession({ ...options, copilot, token, ...(clock === undefined ? {} : { clock }), ...(onCut === undefined ? {} : { onCut }) })
        : copilot.openSession({ ...options, auth: { kind: "seat", gitHubTokenProvider: () => seatToken(bearer()) } });
    },

    // Control logs remote connectors' calls in its proxy; a command connector's
    // call runs in the computer, so it is reported with `bearer()`'s key. A failed
    // report does not stop the call.
    reportCalls: (connectors: AgentConnector[], bearer: () => string) => async (serverName: string, toolName: string) => {
      if (!connectors.some(({ name, kind }) => name === serverName && kind === "command")) return;
      const call: ReportedConnectorCall = { connector: serverName, tool: toolName };
      await Promise.resolve()
        .then(() => fromControl("/connector-calls", bearer(), { method: "POST", body: JSON.stringify(call) }))
        .catch(() => {});
    },

    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
      forwarder?.stop(true);
    },
  };
}

// Whether `given` is the secret, in time that does not depend on where they differ.
const sameSecret = (given: string, secret: string) =>
  timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(secret).digest());

// A copy of only the `names` headers that are set.
function pick(headers: Headers, names: string[]) {
  const picked = new Headers();
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) picked.set(name, value);
  }
  return picked;
}
