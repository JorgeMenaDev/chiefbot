import { ChatView, type Bot, type BotId, type ChatItem } from "@chiefbot/contracts";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

// The bot's chat as Electron main folds it, kept live over chat:state.
function useChat(botId: BotId) {
  const [view, setView] = useState<ChatView>({ botId, items: [], working: null });
  useEffect(() => {
    const unsubscribe = window.chiefbot.chat.onChange((next) => {
      const parsed = ChatView.parse(next);
      if (parsed.botId === botId) setView(parsed);
    });
    void window.chiefbot.chat.open(botId).then((next) => setView(ChatView.parse(next)));
    return unsubscribe;
  }, [botId]);
  return view;
}

// T3 Code's chat shape: a centred lane of messages (user on the right, the bot's
// replies as plain text, tool calls as one-line rows), the bot's status, and the
// composer at the bottom. Enter sends, Shift+Enter adds a line.
export function Chat({ bot }: { bot: Bot }) {
  const view = useChat(bot.id);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const working = view.working !== null;
  // The agent waits while the user has its screen.
  const humanHasScreen = bot.screenControl === "human";
  const canSend = bot.status === "online" && !humanHasScreen && !working && draft.trim() !== "";

  // A block body on purpose: Chromium's scrollIntoView returns a promise, and an
  // effect must return nothing or a cleanup function.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [view]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    setError(null);
    try {
      await window.chiefbot.chat.send(bot.id, draft);
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  return (
    <section className="chat">
      <div className="messages">
        <div className="lane">
          {view.items.length === 0 && <p className="muted empty">Send {bot.name} a message to start.</p>}
          {view.items.map((item) => (
            <Message key={item.id} botId={bot.id} item={item} />
          ))}
          {working && <p className="working">{view.working || "Working"}…</p>}
          <div ref={end} />
        </div>
      </div>
      <form className="composer lane" onSubmit={(event) => void submit(event)}>
        <textarea
          rows={3}
          placeholder={
            bot.status !== "online"
              ? `${bot.name} is ${bot.status}`
              : humanHasScreen
                ? `Hand the screen back to message ${bot.name}`
                : `Message ${bot.name}`
          }
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-row">
          <ModelPicker bot={bot} onError={setError} />
          {error ? <span className="error composer-error">{error}</span> : <span />}
          <button type="submit" disabled={!canSend}>
            Send
          </button>
        </div>
      </form>
    </section>
  );
}

function Message({ botId, item }: { botId: BotId; item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return <div className="message user">{item.text}</div>;
    case "assistant":
      return <div className="message assistant">{item.text}</div>;
    case "tool":
      return (
        <div className={`tool-row ${item.status}`}>
          <span className="tool-mark">{toolMark[item.status]}</span> {item.name}
        </div>
      );
    case "error":
      return <div className="message error">{item.message}</div>;
    case "approval":
      return <ApprovalCard item={item} onAnswer={(approved) => window.chiefbot.chat.answer(botId, item.approvalId, approved)} />;
  }
}

const toolMark: Record<Extract<ChatItem, { kind: "tool" }>["status"], string> = {
  running: "…",
  succeeded: "✓",
  failed: "✗",
};
