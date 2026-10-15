import {
  AuthState,
  Bot,
  ChatView,
  Routine,
  type BotId,
  type BotStatus,
  type ChatItem,
  type RoutineInput,
  type RoutineRun,
  type User,
} from "@chiefbot/contracts";
import RFB from "@novnc/novnc";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { z } from "zod";

const BotList = z.array(Bot);
const RoutineList = z.array(Routine);

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
  const [showRoutines, setShowRoutines] = useState(false);
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
          <button onClick={() => setShowRoutines(!showRoutines)}>{showRoutines ? "Hide routines" : "Routines"}</button>
          <button className="danger" onClick={() => void remove(bot.id)}>
            Delete
          </button>
        </div>
      </header>
      {showRoutines && <Routines bot={bot} />}
      <div className="bot-body">
        <Chat bot={bot} />
        <ScreenPane bot={bot} />
      </div>
    </div>
  );
}

// The bot's routines: prompts control runs on a schedule, with the desktop open
// or not. A run's result lands in the chat. The list reloads when the bot's
// status changes, since a run starts and stops a stopped bot.
function Routines({ bot }: { bot: Bot }) {
  const api = window.chiefbot.routines;
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => setRoutines(RoutineList.parse(await api.list(bot.id)));
  useEffect(() => {
    void reload();
  }, [bot.id, bot.status]);

  // Runs one change, then reloads. Control's refusal shows under the list.
  async function act(change: () => Promise<unknown>) {
    setError(null);
    try {
      await change();
      setEditing(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="routines">
      {routines.length === 0 && editing === null && <p className="muted">No routines yet.</p>}
      {routines.map((routine) =>
        editing !== "new" && editing?.id === routine.id ? (
          <RoutineForm
            key={routine.id}
            initial={routine}
            onSave={(input) => act(() => api.update(bot.id, routine.id, input))}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div key={routine.id} className="routine-row">
            <div className="routine-text">
              <strong>{routine.prompt}</strong>
              <span className="muted">
                <code>{routine.cron}</code> in {routine.timezone} · next {new Date(routine.nextDueAt).toLocaleString()}
              </span>
              {routine.lastRun && <LastRun run={routine.lastRun} />}
            </div>
            <div className="actions">
              <button onClick={() => setEditing(routine)}>Edit</button>
              <button className="danger" onClick={() => void act(() => api.remove(bot.id, routine.id))}>
                Delete
              </button>
            </div>
          </div>
        ),
      )}
      {editing === "new" ? (
        <RoutineForm
          initial={{ prompt: "", cron: "0 9 * * 1-5", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }}
          onSave={(input) => act(() => api.create(bot.id, input))}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button className="link-button" onClick={() => setEditing("new")}>
          + New routine
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function LastRun({ run }: { run: RoutineRun }) {
  const when = new Date(run.dueAt).toLocaleString();
  return (
    <span className={run.status === "failed" ? "error" : "muted"}>
      Last run {when}: {run.status}
      {run.error && ` (${run.error})`}
    </span>
  );
}

// Prompt, cron expression and timezone. Saving waits for control, which refuses
// a schedule it cannot run.
function RoutineForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: RoutineInput;
  onSave: (input: RoutineInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [input, setInput] = useState(initial);
  const [busy, setBusy] = useState(false);
  const field = (key: keyof RoutineInput) => ({
    value: input[key],
    disabled: busy,
    onChange: (event: { target: { value: string } }) => setInput({ ...input, [key]: event.target.value }),
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await onSave(input);
    setBusy(false);
  }

  return (
    <form className="routine-form" onSubmit={(event) => void submit(event)}>
      <textarea rows={2} placeholder="What should the bot do?" autoFocus {...field("prompt")} />
      <div className="routine-schedule">
        <label>
          Cron <input placeholder="0 9 * * 1-5" {...field("cron")} />
        </label>
        <label>
          Timezone <input placeholder="Europe/London" {...field("timezone")} />
        </label>
        <button type="submit" disabled={busy || input.prompt.trim() === ""}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
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
          {error ? <span className="error">{error}</span> : <span />}
          <button type="submit" disabled={!canSend}>
            Send
          </button>
        </div>
      </form>
    </section>
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
