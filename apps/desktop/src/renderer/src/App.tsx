import { AuthState, Bot, ChatView, type BotId, type BotStatus, type ChatItem, type User } from "@chiefbot/contracts";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { z } from "zod";

const BotList = z.array(Bot);

// Signed out: the sign-in screen. Signed in: the bot sidebar and the selected bot.
export function App() {
  const [state, setState] = useState<AuthState | null>(null);

  useEffect(() => {
    const unsubscribe = window.chiefbot.auth.onChange((next) => setState(AuthState.parse(next)));
    void window.chiefbot.auth.get().then((next) => setState(AuthState.parse(next)));
    return unsubscribe;
  }, []);

  if (state?.status === "signed-in") return <Workspace user={state.user} />;
  return (
    <main className="screen">
      <h1>Chiefbot</h1>
      {state && <AuthPanel state={state} />}
    </main>
  );
}

function AuthPanel({ state }: { state: Exclude<AuthState, { status: "signed-in" }> }) {
  const { signIn } = window.chiefbot.auth;
  switch (state.status) {
    case "signed-out":
      return <button onClick={() => void signIn()}>Sign in with GitHub</button>;
    case "waiting-for-code":
      return (
        <div className="card">
          <p>Enter this code on GitHub:</p>
          <code className="code">{state.userCode}</code>
          <a href={state.verificationUri} target="_blank" rel="noreferrer">
            Open {state.verificationUri}
          </a>
        </div>
      );
    case "error":
      return (
        <div className="card">
          <p className="error">{state.message}</p>
          <button onClick={() => void signIn()}>Try again</button>
        </div>
      );
  }
}

function useBots() {
  const [bots, setBots] = useState<Bot[]>([]);
  useEffect(() => {
    const unsubscribe = window.chiefbot.bots.onChange((next) => setBots(BotList.parse(next)));
    void window.chiefbot.bots.get().then((next) => setBots(BotList.parse(next)));
    return unsubscribe;
  }, []);
  return bots;
}

// T3 Code's layout: a sidebar of bots on the left, the selected bot on the right.
function Workspace({ user }: { user: User }) {
  const bots = useBots();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = bots.find((bot) => bot.id === selectedId) ?? bots[0];

  return (
    <div className="workspace">
      <aside className="sidebar">
        <NewBot onCreated={setSelectedId} />
        <nav className="bot-list">
          {bots.map((bot) => (
            <button
              key={bot.id}
              className={bot.id === selected?.id ? "bot-row selected" : "bot-row"}
              onClick={() => setSelectedId(bot.id)}
            >
              <StatusDot status={bot.status} />
              <span className="bot-name">{bot.name}</span>
              <span className="bot-status">{bot.status}</span>
            </button>
          ))}
        </nav>
        <footer className="sidebar-footer">
          <div className="account">
            <strong>{user.login}</strong>
            <span className="muted">
              Copilot: {user.copilotPlan ? `${user.copilotPlan.plan} (${user.copilotPlan.sku})` : "none"}
            </span>
          </div>
          <button className="link-button" onClick={() => void window.chiefbot.auth.signOut()}>
            Sign out
          </button>
        </footer>
      </aside>
      <main className="pane">
        {selected ? <BotPane key={selected.id} bot={selected} /> : <p className="muted">Create a bot to start.</p>}
      </main>
    </div>
  );
}

function NewBot({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const bot = Bot.parse(await window.chiefbot.bots.create(name));
      onCreated(bot.id);
      setName("");
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="new-bot" onClick={() => setOpen(true)}>
        + New bot
      </button>
    );
  }
  return (
    <form className="new-bot-form" onSubmit={(event) => void submit(event)}>
      <input
        autoFocus
        placeholder="Bot name"
        value={name}
        maxLength={60}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
      />
      {busy && <p className="muted">Starting its computer…</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function BotPane({ bot }: { bot: Bot }) {
  const { start, stop, remove } = window.chiefbot.bots;
  return (
    <div className="bot-pane">
      <header className="bot-header">
        <div>
          <h2>
            <StatusDot status={bot.status} /> {bot.name}
          </h2>
          <p className="muted">{statusText[bot.status]}</p>
        </div>
        <div className="actions">
          {bot.status === "stopped" ? (
            <button onClick={() => void start(bot.id)}>Start</button>
          ) : (
            <button onClick={() => void stop(bot.id)}>Stop</button>
          )}
          <button className="danger" onClick={() => void remove(bot.id)}>
            Delete
          </button>
        </div>
      </header>
      <Chat bot={bot} />
    </div>
  );
}

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
function Chat({ bot }: { bot: Bot }) {
  const view = useChat(bot.id);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const working = view.working !== null;
  const canSend = bot.status === "online" && !working && draft.trim() !== "";

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
          placeholder={bot.status === "online" ? `Message ${bot.name}` : `${bot.name} is ${bot.status}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-row">
          {error ? <span className="error">{error}</span> : <span />}
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
      return <ApprovalCard botId={botId} item={item} />;
  }
}

type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;

const approvalLabel: Record<ApprovalItem["request"], string> = {
  command: "Command approval",
  "pull-request": "Pull request approval",
  tool: "GitHub tool approval",
};

const approvalOutcome: Record<Exclude<ApprovalItem["state"], "pending">, string> = {
  approved: "Approved",
  declined: "Declined",
  expired: "Expired: the bot restarted before you answered",
};

// What the bot waits on, after T3 Code's ComposerPendingApprovalPanel and
// ComposerPendingApprovalActions: a label, the exact command or pull request,
// and Decline / Approve. It stays answerable until the bot's turn ends, also
// after the app restarts. Answered, it shrinks to one line.
function ApprovalCard({ botId, item }: { botId: BotId; item: ApprovalItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(approved: boolean) {
    setBusy(true);
    setError(null);
    try {
      await window.chiefbot.chat.answer(botId, item.approvalId, approved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (item.state !== "pending") {
    return (
      <div className={`approval-row ${item.state}`}>
        {approvalLabel[item.request]}: {approvalOutcome[item.state]} <code>{item.detail.split("\n")[0]}</code>
      </div>
    );
  }
  return (
    <div className="approval-card" role="group" aria-label={approvalLabel[item.request]}>
      <span className="approval-label">{approvalLabel[item.request]}</span>
      <code className="approval-detail">{item.detail}</code>
      <div className="approval-actions">
        {error && <span className="error">{error}</span>}
        <button className="outline" disabled={busy} onClick={() => void answer(false)}>
          Decline
        </button>
        <button disabled={busy} onClick={() => void answer(true)}>
          Approve
        </button>
      </div>
    </div>
  );
}

const toolMark: Record<Extract<ChatItem, { kind: "tool" }>["status"], string> = {
  running: "…",
  succeeded: "✓",
  failed: "✗",
};

const statusText: Record<BotStatus, string> = {
  starting: "Its computer is starting. The bot comes online when its worker connects.",
  online: "Online. Its worker is connected.",
  stopped: "Stopped. Its files are kept.",
};

// Colour per status, with a ping while starting (after T3 Code's ConnectionStatusDot).
function StatusDot({ status }: { status: BotStatus }) {
  return (
    <span className={`status-dot ${status}`} aria-label={status}>
      {status === "starting" && <span className="ping" />}
      <span className="dot" />
    </span>
  );
}
