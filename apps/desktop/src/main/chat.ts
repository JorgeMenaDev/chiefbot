import {
  ChatEvent,
  SendMessageResponse,
  type ApprovalId,
  type AttachmentId,
  type AttachmentUpload,
  type BotId,
  type ChatItem,
  type ChatView,
  type HandoffId,
  type QuestionId,
  type QuestionResult,
  type ReplyToHandoffRequest,
} from "@chiefbot/contracts";
import { controlCaller } from "./controlApi.ts";

export type ChatsOptions = {
  controlUrl: string;
  // The saved control session, or null when signed out.
  session: () => string | null;
  onChange: (view: ChatView) => void;
  // Wait between reconnects after a chat socket drops.
  retryMs?: number;
};

// Follows one chat over a WebSocket to control: its whole history first, then
// live events. On reconnect it asks only for events after the last one it has,
// so a dropped connection or a control restart resumes the stream.
// `path(after)` is the chat's WebSocket path, e.g. /bots/:id/chat?after=…
export function followChat({
  controlUrl,
  session,
  path,
  onEvent,
  retryMs,
}: {
  controlUrl: string;
  session: () => string | null;
  path: (after: number) => string;
  onEvent: (event: ChatEvent) => void;
  retryMs: number;
}) {
  let lastSeq = 0;
  let socket: WebSocket | null = null;
  let retry: Timer | null = null;
  let closed = false;

  function connect() {
    const token = session();
    if (!token) return;
    socket = new WebSocket(`${controlUrl.replace(/^http/, "ws")}${path(lastSeq)}`, { headers: { authorization: `Bearer ${token}` } });
    socket.onmessage = (message) => {
      const event = ChatEvent.parse(JSON.parse(String(message.data)));
      lastSeq = event.seq;
      onEvent(event);
    };
    socket.onclose = () => {
      if (!closed) retry = setTimeout(connect, retryMs);
    };
  }
  connect();

  return {
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    },
  };
}

// The bots' chats, owned by Electron main. Each opened chat follows control's /bots/:id/chat.
export function createChats({ controlUrl, session, onChange, retryMs = 2000 }: ChatsOptions) {
  const chats = new Map<BotId, { view: ChatView; close: () => void }>();
  const call = controlCaller({ controlUrl, session });

  return {
    // Starts following a bot's chat (its whole history first). Repeat calls are harmless.
    open(botId: BotId) {
      if (chats.has(botId)) return;
      const chat = { view: { botId, items: [], working: null }, close: () => {} };
      chats.set(botId, chat);
      chat.close = followChat({
        controlUrl,
        session,
        retryMs,
        path: (after) => `/bots/${botId}/chat?after=${after}`,
        onEvent: (event) => {
          chat.view = foldChat(chat.view, event);
          onChange(chat.view);
        },
      }).close;
    },

    view: (botId: BotId): ChatView => chats.get(botId)?.view ?? { botId, items: [], working: null },

    // Sends `text` and the files with it. Throws with control's reason when it
    // refuses (bot offline, still on a turn, a file over the limits).
    async send(botId: BotId, text: string, attachments: AttachmentUpload[] = []) {
      const res = await call("POST", `/bots/${botId}/messages`, { text, attachments });
      return SendMessageResponse.parse(await res.json()).turnId;
    },

    // A file sent with one of the bot's messages, as a data: URL the window can
    // show (its CSP allows data: images).
    async attachment(botId: BotId, attachmentId: AttachmentId) {
      const res = await call("GET", `/bots/${botId}/attachments/${attachmentId}`);
      return `data:${res.headers.get("content-type")};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
    },

    // Approves or declines one of the bot's pending approvals. The card updates
    // when control's approval-answer comes back on the chat socket.
    async answer(botId: BotId, approvalId: ApprovalId, approved: boolean) {
      await call("POST", `/bots/${botId}/approvals/${approvalId}`, { approved });
    },

    // Answers (or declines) one of the bot's pending questions. The card updates
    // when control's question-answer comes back on the chat socket.
    async answerQuestion(botId: BotId, questionId: QuestionId, result: QuestionResult) {
      await call("POST", `/bots/${botId}/questions/${questionId}`, result);
    },

    // The owner's answer to a handoff's question, from its card in the bot's chat.
    // Throws with control's refusal, e.g. 409 question_changed.
    async replyToHandoff(botId: BotId, handoffId: HandoffId, reply: ReplyToHandoffRequest) {
      await call("POST", `/bots/${botId}/handoffs/${handoffId}/messages`, reply);
    },

    // Call on sign-out.
    disconnect() {
      const open = [...chats.values()];
      chats.clear();
      for (const chat of open) chat.close();
    },
  };
}

const waitingForApproval = "Waiting for your approval";
const waitingForAnswer = "Waiting for your answer";

// What the bot's status says while a card is still pending (a question first),
// whatever else the turn reports; "" once none is.
function stillWaiting(items: ChatItem[]) {
  const pending = (kind: "approval" | "question") => items.some((item) => item.kind === kind && item.state === "pending");
  return pending("question") ? waitingForAnswer : pending("approval") ? waitingForApproval : "";
}

// Folds one stored chat event into what the window shows. Item ids are scoped
// to their turn, since the SDK's message and tool ids are only unique per turn.
// While an approval or a question is pending, the bot's status says it waits for the user.
// The view is a bot's chat or a member's chat with a project's coordinator.
export function foldChat<View extends Pick<ChatView, "items" | "working">>(view: View, { turnId, event }: ChatEvent): View {
  const upsert = (id: string, make: (existing: ChatItem | undefined) => ChatItem) => {
    const index = view.items.findIndex((item) => item.id === id);
    if (index === -1) return [...view.items, make(undefined)];
    return view.items.with(index, make(view.items[index]));
  };
  switch (event.type) {
    case "user-message":
      return { ...view, working: "", items: [...view.items, { kind: "user", id: turnId, text: event.text, attachments: event.attachments }] };
    case "payer":
      return { ...view, items: [...view.items, { kind: "payer", id: `${turnId}:payer`, payer: event.payer }] };
    case "text-delta": {
      const id = `${turnId}:${event.messageId}`;
      const items = upsert(id, (existing) => ({
        kind: "assistant",
        id,
        text: (existing?.kind === "assistant" ? existing.text : "") + event.text,
      }));
      return { ...view, items };
    }
    case "tool-call": {
      const id = `${turnId}:${event.toolCallId}`;
      return { ...view, items: upsert(id, () => ({ kind: "tool", id, name: event.name, status: event.status })) };
    }
    case "status":
      return { ...view, working: stillWaiting(view.items) || event.text };
    case "error":
      return { ...view, items: [...view.items, { kind: "error", id: `${turnId}:error`, message: event.message }] };
    case "approval-request": {
      const { approvalId, kind, detail } = event;
      const card: ChatItem = { kind: "approval", id: `${turnId}:${approvalId}`, approvalId, request: kind, detail, state: "pending" };
      return { ...view, working: waitingForApproval, items: [...view.items, card] };
    }
    // Control's notes about a handoff leave any running turn as it is. A card
    // stays where the handoff's first appeared, showing its latest.
    case "handoff-card": {
      const id = `handoff:${event.card.handoffId}`;
      return { ...view, items: upsert(id, () => ({ kind: "handoff", id, ...event.card })) };
    }
    case "handoff-update":
      return { ...view, items: [...view.items, { kind: "notice", id: `${turnId}:notice`, text: event.text }] };
    case "approval-answer": {
      const state = event.approved ? "approved" : "declined";
      const items = view.items.map(
        (item): ChatItem => (item.kind === "approval" && item.approvalId === event.approvalId ? { ...item, state } : item),
      );
      return { ...view, working: stillWaiting(items), items };
    }
    // A withdrawn approval can no longer be answered. The turn goes on.
    case "approval-withdrawn": {
      const items = view.items.map(
        (item): ChatItem => (item.kind === "approval" && item.approvalId === event.approvalId ? { ...item, state: "withdrawn" } : item),
      );
      return { ...view, working: stillWaiting(items), items };
    }
    case "question-request": {
      const { questionId, form } = event;
      const card: ChatItem = { kind: "question", id: `${turnId}:${questionId}`, questionId, form, state: "pending" };
      return { ...view, working: waitingForAnswer, items: [...view.items, card] };
    }
    // An answer or a withdrawal settles only a question still pending.
    case "question-answer":
    case "question-withdrawn": {
      const settled = event.type === "question-answer" ? { state: "answered" as const, answer: event.result } : { state: "withdrawn" as const };
      const items = view.items.map(
        (item): ChatItem => (item.kind === "question" && item.questionId === event.questionId && item.state === "pending" ? { ...item, ...settled } : item),
      );
      return { ...view, working: stillWaiting(items), items };
    }
    // Only engineers set up, and no chat shows an engineer's turn.
    case "setup-step":
    case "setup-done":
      return view;
    // Approvals and questions left pending when a turn ends can no longer be answered.
    case "done": {
      const items = view.items.map(
        (item): ChatItem =>
          (item.kind === "approval" || item.kind === "question") && item.state === "pending" && item.id.startsWith(`${turnId}:`)
            ? { ...item, state: "expired" }
            : item,
      );
      return { ...view, working: null, items };
    }
  }
}
