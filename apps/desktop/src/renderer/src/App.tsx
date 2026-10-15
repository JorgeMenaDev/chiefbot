import {
  AUTO_MODEL,
  AuthState,
  Bot,
  ChatView,
  ModelOption,
  type BotId,
  type BotStatus,
  type ChatItem,
  type User,
} from "@chiefbot/contracts";
import RFB from "@novnc/novnc";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { z } from "zod";

const BotList = z.array(Bot);
const ModelList = z.array(ModelOption);

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

// The selected bot: its controls, with its live screen in a side pane.
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
      <div className="bot-body">
        <Chat bot={bot} />
        <ScreenPane bot={bot} />
      </div>
    </div>
  );
}

// The bot's live screen, through control. The user watches until they take
// over; then mouse and keyboard go to the bot's computer and the agent waits.
function ScreenPane({ bot }: { bot: Bot }) {
  const { takeOver, handBack } = window.chiefbot.bots;
  const human = bot.screenControl === "human";
  return (
    <aside className="screen-pane">
      <header className="screen-header">
        <span className="muted">{human ? "You have control. The bot waits." : "Watching. The bot drives."}</span>
        {human ? (
          <button onClick={() => void handBack(bot.id)}>Hand back</button>
        ) : (
          <button onClick={() => void takeOver(bot.id)} disabled={bot.status !== "online"}>
            Take over
          </button>
        )}
      </header>
      {bot.status === "online" ? (
        <LiveScreen key={bot.id} botId={bot.id} interactive={human} />
      ) : (
        <div className="screen-view screen-empty muted">The screen shows when the bot is online.</div>
      )}
    </aside>
  );
}

// noVNC on control's screen WebSocket. It reconnects after a drop, so a screen
// that is still starting shows up on its own.
function LiveScreen({ botId, interactive }: { botId: string; interactive: boolean }) {
  const target = useRef<HTMLDivElement>(null);
  const client = useRef<RFB | null>(null);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void window.chiefbot.bots.screenUrl(botId).then((url) => {
      if (cancelled) return;
      const rfb = new RFB(element, url);
      rfb.scaleViewport = true;
      rfb.viewOnly = true;
      rfb.addEventListener("connect", () => setConnected(true));
      rfb.addEventListener("disconnect", () => {
        setConnected(false);
        if (!cancelled) retry = setTimeout(() => setAttempt((count) => count + 1), 2000);
      });
      client.current = rfb;
    });
    return () => {
      cancelled = true;
      clearTimeout(retry);
      client.current?.disconnect();
      client.current = null;
    };
  }, [botId, attempt]);

  // Input reaches the bot's computer only while the user has control.
  useEffect(() => {
    if (client.current) client.current.viewOnly = !interactive;
  }, [interactive, connected]);

  return (
    <div className={interactive ? "screen-view interactive" : "screen-view"}>
      <div ref={target} className="screen-canvas" />
      {!connected && <p className="screen-overlay muted">Connecting to the screen…</p>}
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
            <Message key={item.id} item={item} />
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

// The bot's model, after T3 Code's ProviderModelPicker and ModelListRow (via
// Chartpilot's port): a trigger with the Copilot mark and the model's name, opening
// a searchable list of the plan's models above the composer. Locked rows show why
// in place of the provider line and cannot be picked. The pick is saved on the bot.
function ModelPicker({ bot, onError }: { bot: Bot; onError: (message: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const name = models.find((model) => model.id === bot.model)?.name ?? (bot.model === AUTO_MODEL ? "Auto" : bot.model);
  const q = query.trim().toLowerCase();
  const visible = q ? models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(q)) : models;

  // Reads the plan's models on mount and on every open, so a new report shows.
  useEffect(() => {
    void window.chiefbot.bots.models().then((next) => setModels(ModelList.parse(next)));
  }, [open]);

  // A click outside or Escape closes the list.
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
      setQuery("");
    };
  }, [open]);

  async function choose(model: ModelOption) {
    if (model.lockedReason !== null) return;
    setOpen(false);
    onError(null);
    try {
      await window.chiefbot.bots.setModel(bot.id, model.id);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="model-picker" ref={root}>
      <button type="button" className="model-trigger" aria-label={`Model: ${name}`} onClick={() => setOpen(!open)}>
        <CopilotIcon className="icon" />
        <span className="model-trigger-name">{name}</span>
        <svg className="icon chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="model-popup">
          <input
            autoFocus
            className="model-search"
            placeholder="Search models..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div role="listbox" className="model-list">
            {visible.map((model) => (
              <ModelRow key={model.id} model={model} selected={model.id === bot.model} onSelect={() => void choose(model)} />
            ))}
            {visible.length === 0 && <p className="muted model-empty">No models found</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelRow({ model, selected, onSelect }: { model: ModelOption; selected: boolean; onSelect: () => void }) {
  const locked = model.lockedReason !== null;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={locked}
      title={model.lockedReason ?? undefined}
      className={`model-row${selected ? " selected" : ""}${locked ? " locked" : ""}`}
      onClick={onSelect}
    >
      <span className="model-row-text">
        <span className="model-row-name">{model.name}</span>
        <span className="model-row-provider">
          <CopilotIcon className="icon small" />
          {model.lockedReason ?? "GitHub Copilot"}
        </span>
      </span>
      {locked ? (
        <svg className="icon small" viewBox="0 0 24 24" aria-label="Locked">
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
      ) : (
        selected && (
          <svg className="icon" viewBox="0 0 24 24" aria-label="Selected">
            <path d="M5 12l5 5 9-10" />
          </svg>
        )
      )}
    </button>
  );
}

// GitHub Copilot's mark (GitHub's Octicons, MIT), as T3 Code shows it for the Copilot provider.
function CopilotIcon({ className }: { className: string }) {
  return (
    <svg className={`${className} filled`} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" />
    </svg>
  );
}

function Message({ item }: { item: ChatItem }) {
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
  }
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
