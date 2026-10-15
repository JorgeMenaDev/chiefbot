import { ChatEvent, SendMessageResponse, type ApprovalId, type BotId, type ChatItem, type ChatView } from "@chiefbot/contracts";
import { controlCaller } from "./controlApi.ts";

export type ChatsOptions = {
  controlUrl: string;
  // The saved control session, or null when signed out.
  session: () => string | null;
  onChange: (view: ChatView) => void;
  // Wait between reconnects after a chat socket drops.
  retryMs?: number;
};

// The bots' chats, owned by Electron main. Each opened chat keeps a WebSocket to
// control's /bots/:id/chat. On reconnect it asks only for events after the last
// one it has, so a dropped connection or a control restart resumes the stream.
export function createChats({ controlUrl, session, onChange, retryMs = 2000 }: ChatsOptions) {
  type Chat = { view: ChatView; lastSeq: number; socket: WebSocket | null; retry: Timer | null };
  const chats = new Map<BotId, Chat>();
  const call = controlCaller({ controlUrl, session });

  function connect(botId: BotId, chat: Chat) {
    const token = session();
    if (!token) return;
    const socket = new WebSocket(`${controlUrl.replace(/^http/, "ws")}/bots/${botId}/chat?after=${chat.lastSeq}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    chat.socket = socket;
    socket.onmessage = (message) => {
      const event = ChatEvent.parse(JSON.parse(String(message.data)));
      chat.lastSeq = event.seq;
      chat.view = foldChat(chat.view, event);
      onChange(chat.view);
    };
    socket.onclose = () => {
      if (chats.get(botId) === chat) chat.retry = setTimeout(() => connect(botId, chat), retryMs);
    };
  }

  return {
    // Starts following a bot's chat (its whole history first). Repeat calls are harmless.
    open(botId: BotId) {
      if (chats.has(botId)) return;
      const chat: Chat = { view: { botId, items: [], working: null }, lastSeq: 0, socket: null, retry: null };
      chats.set(botId, chat);
      connect(botId, chat);
    },

    view: (botId: BotId): ChatView => chats.get(botId)?.view ?? { botId, items: [], working: null },

    // Throws with control's reason when it refuses (bot offline, still on a turn).
    async send(botId: BotId, text: string) {
      const res = await call("POST", `/bots/${botId}/messages`, { text });
      return SendMessageResponse.parse(await res.json()).turnId;
    },

    // Approves or declines one of the bot's pending approvals. The card updates
    // when control's approval-answer comes back on the chat socket.
    async answer(botId: BotId, approvalId: ApprovalId, approved: boolean) {
      await call("POST", `/bots/${botId}/approvals/${approvalId}`, { approved });
    },

    // Call on sign-out.
    disconnect() {
      const open = [...chats.values()];
      chats.clear();
      for (const chat of open) {
        if (chat.retry) clearTimeout(chat.retry);
        chat.socket?.close();
      }
    },
  };
}

const waitingForApproval = "Waiting for your approval";

// Folds one stored chat event into what the window shows. Item ids are scoped
// to their turn, since the SDK's message and tool ids are only unique per turn.
// While an approval is pending, the bot's status says it waits for the user.
export function foldChat(view: ChatView, { turnId, event }: ChatEvent): ChatView {
  const upsert = (id: string, make: (existing: ChatItem | undefined) => ChatItem) => {
    const index = view.items.findIndex((item) => item.id === id);
    if (index === -1) return [...view.items, make(undefined)];
    return view.items.with(index, make(view.items[index]));
  };
  switch (event.type) {
    case "user-message":
      return { ...view, working: "", items: [...view.items, { kind: "user", id: turnId, text: event.text }] };
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
      return { ...view, working: event.text };
    case "error":
      return { ...view, items: [...view.items, { kind: "error", id: `${turnId}:error`, message: event.message }] };
    case "approval-request": {
      const { approvalId, kind, detail } = event;
      const card: ChatItem = { kind: "approval", id: `${turnId}:${approvalId}`, approvalId, request: kind, detail, state: "pending" };
      return { ...view, working: waitingForApproval, items: [...view.items, card] };
    }
    case "approval-answer": {
      const state = event.approved ? "approved" : "declined";
      const items = view.items.map(
        (item): ChatItem => (item.kind === "approval" && item.approvalId === event.approvalId ? { ...item, state } : item),
      );
      return { ...view, working: "", items };
    }
    // Approvals left pending when a turn ends can no longer be answered.
    case "done": {
      const items = view.items.map(
        (item): ChatItem =>
          item.kind === "approval" && item.state === "pending" && item.id.startsWith(`${turnId}:`) ? { ...item, state: "expired" } : item,
      );
      return { ...view, working: null, items };
    }
  }
}
