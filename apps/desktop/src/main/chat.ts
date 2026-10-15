import { ChatEvent, SendMessageResponse, type BotId, type ChatItem, type ChatView } from "@chiefbot/contracts";

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
      const res = await fetch(`${controlUrl}/bots/${botId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${session() ?? ""}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`Control refused (${res.status}): ${await res.text()}`);
      return SendMessageResponse.parse(await res.json()).turnId;
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

// Folds one stored chat event into what the window shows. Item ids are scoped
// to their turn, since the SDK's message and tool ids are only unique per turn.
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
    case "done":
      return { ...view, working: null };
  }
}
