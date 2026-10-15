import type { SessionEvent } from "@github/copilot-sdk";
import {
  BotId,
  BrokeredGitHubToken,
  ControlToWorker,
  type ScreenControl,
  type TurnEvent,
  type TurnId,
  type WorkerToControl,
} from "@chiefbot/contracts";
import type { BotSession, Copilot } from "./copilot.ts";
import { modelReport } from "./models.ts";
import { openScreenStream, type ScreenAddress } from "./screen.ts";

export type WorkerOptions = {
  // Control's base URL as seen from the computer, e.g. http://host.docker.internal:7410.
  controlUrl: string;
  // The bot this computer belongs to, from CHIEFBOT_BOT_ID.
  botId: string;
  // The bot's credential from CHIEFBOT_BOT_TOKEN.
  botToken: string;
  // The agent engine: the Copilot SDK in a bot computer, a fake in tests.
  copilot: Copilot;
  // The computer's VNC server. Default: x11vnc on 127.0.0.1:5900.
  screen?: ScreenAddress;
  // Wait between reconnects after the connection drops.
  retryMs?: number;
  onBound?: (botId: BotId) => void;
  // Listing the plan's models failed; control keeps its last report.
  onModelsError?: (error: unknown) => void;
};

// Dials out to control's /worker/:botId WebSocket with the bot's credential and keeps
// the connection up: control restarts and network drops end in a reconnect.
// Runs the turns control sends on the bot's Copilot session, one at a time, and
// streams their events back. After each bind it reports the models the owner's
// Copilot plan offers. The latest turn's events are kept and resent on
// every reconnect (control stores each once), so a turn survives a control restart.
// On `screen-open` it pipes the screen to a viewer through control (screen.ts).
export function startWorker({
  controlUrl,
  botId,
  botToken,
  copilot,
  screen = { hostname: "127.0.0.1", port: 5900 },
  retryMs = 2000,
  onBound,
  onModelsError,
}: WorkerOptions) {
  const url = `${controlUrl.replace(/^http/, "ws")}/worker/${botId}`;
  // Each open screen stream's close function.
  const streams = new Set<() => void>();
  let socket: WebSocket | null = null;
  let retry: Timer | null = null;
  let stopped = false;
  // Who drives the screen, as control last said. Agent input to the screen waits while it is "human".
  let screenControl: ScreenControl = "agent";
  // Every event of the latest turn, numbered by position.
  let latest: { turnId: TurnId; events: TurnEvent[] } | null = null;
  let session: Promise<BotSession> | null = null;
  // The model set on the open session, or null before the first turn sets one.
  let sessionModel: string | null = null;
  // The turn the session is running, and what it has streamed so far.
  let active: { turnId: TurnId; deltaMessageIds: Set<string>; toolNames: Map<string, string> } | null = null;

  function send(message: WorkerToControl) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function emit(turnId: TurnId, event: TurnEvent) {
    if (latest?.turnId !== turnId) latest = { turnId, events: [] };
    latest.events.push(event);
    send({ type: "turn-event", turnId, index: latest.events.length - 1, event });
    if (event.type === "done" && active?.turnId === turnId) active = null;
  }

  // Short-lived GitHub access token for the SDK, from control's broker.
  async function gitHubToken() {
    const res = await fetch(`${controlUrl}/worker/${botId}/github-token`, { headers: { authorization: `Bearer ${botToken}` } });
    if (!res.ok) throw new Error(`Control's token broker answered ${res.status}`);
    const { accessToken, expiresAt } = BrokeredGitHubToken.parse(await res.json());
    return { kind: "token" as const, accessToken, expiresIn: Math.floor((expiresAt - Date.now()) / 1000) };
  }

  // The bot's one Copilot session, opened on its first turn. Its id is the bot
  // id, so after a restart the worker resumes the same conversation.
  function openSession() {
    session ??= copilot.openSession({ sessionId: BotId.parse(botId), gitHubTokenProvider: gitHubToken }).then((opened) => {
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
    const { turnId, deltaMessageIds, toolNames } = active;
    switch (event.type) {
      case "assistant.intent":
        return emit(turnId, { type: "status", text: event.data.intent });
      case "assistant.message_delta":
        deltaMessageIds.add(event.data.messageId);
        return emit(turnId, { type: "text-delta", messageId: event.data.messageId, text: event.data.deltaContent });
      // The whole message. Sent as one chunk only when it did not stream.
      case "assistant.message":
        if (deltaMessageIds.has(event.data.messageId) || !event.data.content) return;
        return emit(turnId, { type: "text-delta", messageId: event.data.messageId, text: event.data.content });
      case "tool.execution_start": {
        const name = event.data.toolTitle ?? event.data.toolName;
        toolNames.set(event.data.toolCallId, name);
        return emit(turnId, { type: "tool-call", toolCallId: event.data.toolCallId, name, status: "running" });
      }
      case "tool.execution_complete":
        return emit(turnId, {
          type: "tool-call",
          toolCallId: event.data.toolCallId,
          name: toolNames.get(event.data.toolCallId) ?? "tool",
          status: event.data.success ? "succeeded" : "failed",
        });
      case "session.error":
        emit(turnId, { type: "error", message: event.data.message });
        return emit(turnId, { type: "done" });
      case "session.idle":
        return emit(turnId, { type: "done" });
    }
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
  async function runTurn(turnId: TurnId, text: string, model: string) {
    active = { turnId, deltaMessageIds: new Set(), toolNames: new Map() };
    try {
      const opened = await openSession();
      if (sessionModel !== model) {
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
    socket = new WebSocket(url, { headers: { authorization: `Bearer ${botToken}` } });
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
          onBound?.(message.botId);
          void reportModels();
          break;
        case "run-turn":
          void runTurn(message.turnId, message.text, message.model);
          break;
        case "screen-control":
          screenControl = message.control;
          break;
        case "screen-open": {
          const close = openScreenStream(`${url}/screen/${message.streamId}`, botToken, screen, () =>
            streams.delete(close),
          );
          streams.add(close);
          break;
        }
      }
    };
    socket.onclose = () => {
      if (!stopped) retry = setTimeout(connect, retryMs);
    };
  }
  connect();

  return {
    screenControl: () => screenControl,
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
      for (const close of streams) close();
    },
  };
}
