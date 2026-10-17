import type { PermissionHandler, SessionEvent } from "@github/copilot-sdk";
import {
  ApprovalId,
  BotId,
  BrokeredGitHubToken,
  BrokerRefusal,
  ControlToWorker,
  type ApprovalKind,
  type ScreenControl,
  type TurnEvent,
  type TurnId,
  type WorkerToControl,
} from "@chiefbot/contracts";
import { rmSync } from "node:fs";
import { approvalFor } from "./approvals.ts";
import type { BotSession, Copilot } from "./copilot.ts";
import { modelReport } from "./models.ts";
import { pullRequestTool } from "./pullRequest.ts";
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
  // Unix socket where git's credential helper (gitCredential.ts) asks for the
  // bot's credential for control's git proxy. No socket when unset.
  gitSocket?: string;
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
// While the human has the screen (take-over), every tool call waits for hand-back.
// Risky tool calls (approvals.ts) wait for the user's answer, which control relays.
// Pushes and pull requests go through control, which asks the user itself.
export function startWorker({
  controlUrl,
  botId,
  botToken,
  copilot,
  gitSocket,
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
  let active: { turnId: TurnId; deltaMessageIds: Set<string>; toolNames: Map<string, string> } | null = null;
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
    const res = await fetch(`${controlUrl}/worker/${botId}/github-token`, { headers: { authorization: `Bearer ${botToken}` } });
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

  // The bot's one Copilot session, opened by reportModels when the worker first
  // binds (or by the next turn, if that open failed). Its id is the bot id, so
  // after a restart the worker resumes the same conversation.
  function openSession() {
    const tools = [pullRequestTool({ controlUrl, botId, botToken })];
    session ??= copilot.openSession({ sessionId: BotId.parse(botId), gitHubTokenProvider: gitHubToken, onPermissionRequest, tools }).then((opened) => {
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
          if (screenControl === "agent") {
            for (const wake of handBackWaiters) wake();
            handBackWaiters.clear();
          }
          break;
        case "screen-open": {
          const close = openScreenStream(`${url}/screen/${message.streamId}`, botToken, screen, () =>
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

  // Git's credential helper asks here for the bot's credential, which control's
  // git proxy takes (never a GitHub token), so it is never written to disk. A
  // stopped container keeps /tmp, so a stale socket file is removed first.
  let git: Bun.Server<undefined> | null = null;
  if (gitSocket) {
    rmSync(gitSocket, { force: true });
    git = Bun.serve({ unix: gitSocket, fetch: () => new Response(`username=chiefbot\npassword=${botToken}\n`) });
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
