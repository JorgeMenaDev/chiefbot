import { AuthState, Bot, type BotStatus, type User } from "@chiefbot/contracts";
import RFB from "@novnc/novnc";
import { useEffect, useRef, useState, type FormEvent } from "react";
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
      <main className="pane">{selected ? <BotPane bot={selected} /> : <p className="muted">Create a bot to start.</p>}</main>
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
      <section className="bot-main">
        <h2>
          <StatusDot status={bot.status} /> {bot.name}
        </h2>
        <p className="muted">{statusText[bot.status]}</p>
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
      </section>
      <ScreenPane bot={bot} />
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
