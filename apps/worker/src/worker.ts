import type { PermissionHandler, SessionEvent } from "@github/copilot-sdk";
import {
  ApprovalId,
  BotId,
  BrokeredGitHubToken,
  ControlToWorker,
  type TurnEvent,
  type TurnId,
  type WorkerToControl,
} from "@chiefbot/contracts";
import { rmSync } from "node:fs";
import { approvalFor } from "./approvals.ts";
import type { BotSession, Copilot } from "./copilot.ts";
import { pullRequestTool } from "./pullRequest.ts";

export type WorkerOptions = {
  // Control's base URL as seen from the computer, e.g. http://host.docker.internal:7410.
  controlUrl: string;
  // The bot this computer belongs to, from CHIEFBOT_BOT_ID.
  botId: string;
  // The bot's credential from CHIEFBOT_BOT_TOKEN.
  botToken: string;
  // The agent engine: the Copilot SDK in a bot computer, a fake in tests.
  copilot: Copilot;
  // api.github.com in a bot computer; a fake in tests. The pull request tool calls it.
  githubApiUrl?: string;
  // Unix socket the git credential helper (gitCredential.ts) asks for the owner's
  // token. No socket when unset.
  gitCredentialSocket?: string;
  // Wait between reconnects after the connection drops.
  retryMs?: number;
  onBound?: (botId: BotId) => void;
};

// Dials out to control's /worker/:botId WebSocket with the bot's credential and keeps
// the connection up: control restarts and network drops end in a reconnect.
// Runs the turns control sends on the bot's Copilot session, one at a time, and
// streams their events back. The latest turn's events are kept and resent on
// every reconnect (control stores each once), so a turn survives a control restart.
// Risky tool calls (approvals.ts) wait for the user's answer, which control relays.
export function startWorker({
  controlUrl,
  botId,
  botToken,
  copilot,
  githubApiUrl = "https://api.github.com",
  gitCredentialSocket,
  retryMs = 2000,
  onBound,
}: WorkerOptions) {
  const url = `${controlUrl.replace(/^http/, "ws")}/worker/${botId}`;
  let socket: WebSocket | null = null;
  let retry: Timer | null = null;
  let stopped = false;
  // Every event of the latest turn, numbered by position.
  let latest: { turnId: TurnId; events: TurnEvent[] } | null = null;
  let session: Promise<BotSession> | null = null;
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

  // Short-lived GitHub access token for the SDK, from control's broker.
  async function gitHubToken() {
    const res = await fetch(`${controlUrl}/worker/${botId}/github-token`, { headers: { authorization: `Bearer ${botToken}` } });
    if (!res.ok) throw new Error(`Control's token broker answered ${res.status}`);
    const { accessToken, expiresAt } = BrokeredGitHubToken.parse(await res.json());
    return { kind: "token" as const, accessToken, expiresIn: Math.floor((expiresAt - Date.now()) / 1000) };
  }

  // Runs safe tool calls at once. A risky one becomes an approval-request in the
  // chat, and the session waits, however long, until the user answers.
  const onPermissionRequest: PermissionHandler = async (request) => {
    const ask = approvalFor(request);
    if (!ask) return { kind: "approve-once" };
    if (!active) return { kind: "reject", feedback: "Nobody is here to approve this outside a turn." };
    const approvalId = ApprovalId.parse(`approval_${crypto.randomUUID()}`);
    const answered = new Promise<boolean>((resolve) => waiting.set(approvalId, resolve));
    emit(active.turnId, { type: "approval-request", approvalId, ...ask });
    return (await answered)
      ? { kind: "approve-once", approvedInteractively: true }
      : { kind: "reject", feedback: "The user declined this." };
  };

  // The bot's one Copilot session, opened on its first turn. Its id is the bot
  // id, so after a restart the worker resumes the same conversation.
  function openSession() {
    const tools = [pullRequestTool({ githubApiUrl, token: async () => (await gitHubToken()).accessToken })];
    session ??= copilot.openSession({ sessionId: BotId.parse(botId), gitHubTokenProvider: gitHubToken, onPermissionRequest, tools }).then((opened) => {
      opened.on(onSessionEvent);
      return opened;
    });
    session.catch(() => (session = null));
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

  // Control sends a turn only once the previous one is done.
  async function runTurn(turnId: TurnId, text: string) {
    active = { turnId, deltaMessageIds: new Set(), toolNames: new Map() };
    try {
      await (await openSession()).send(text);
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
      if (message.type === "bound") onBound?.(message.botId);
      else if (message.type === "run-turn") void runTurn(message.turnId, message.text);
      else {
        waiting.get(message.approvalId)?.(message.approved);
        waiting.delete(message.approvalId);
      }
    };
    socket.onclose = () => {
      if (!stopped) retry = setTimeout(connect, retryMs);
    };
  }
  connect();

  // Git's credential helper asks here, so the token is never written to disk.
  // A stopped container keeps /tmp, so a stale socket file is removed first.
  let credentials: Bun.Server<undefined> | null = null;
  if (gitCredentialSocket) {
    rmSync(gitCredentialSocket, { force: true });
    credentials = Bun.serve({
      unix: gitCredentialSocket,
      fetch: async () => {
        try {
          return new Response(`username=x-access-token\npassword=${(await gitHubToken()).accessToken}\n`);
        } catch (error) {
          return new Response(String(error), { status: 502 });
        }
      },
    });
  }

  return {
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
      credentials?.stop(true);
      if (gitCredentialSocket) rmSync(gitCredentialSocket, { force: true });
    },
  };
}
