import { AuthState, Bot, type BotStatus, type User } from "@chiefbot/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { Chat } from "./Chat.tsx";
import { Connectors } from "./Connectors.tsx";
import { Routines } from "./Routines.tsx";
import { ScreenPane } from "./LiveScreen.tsx";
import { NewProject, ProjectPane, useProjects } from "./Projects.tsx";
import { Members, useWorkspaces, WorkspaceSwitcher } from "./Workspaces.tsx";

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

// The current workspace survives a restart; none means "Personal".
const currentWorkspaceKey = "chiefbot.workspace";

// T3 Code's layout: a sidebar of bots on the left, the selected bot on the right.
// The switcher on top picks the current workspace, whose members screen and
// projects open from the sidebar. Bots are personal, so the bot list is the same
// in every workspace.
function Workspace({ user }: { user: User }) {
  const bots = useBots();
  const teams = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState(() => localStorage.getItem(currentWorkspaceKey));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumped by each click on Members or Connectors, which remounts (reloads) the
  // screen: control sends no member or connector events.
  const [membersVisit, setMembersVisit] = useState(0);
  const current = teams.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const { projects, reload: reloadProjects } = useProjects(current);
  const showMembers = current !== null && selectedId === "members";
  const showConnectors = current !== null && selectedId === "connectors";
  const project = projects.find(({ id }) => id === selectedId);
  const selected = bots.find((bot) => bot.id === selectedId) ?? bots[0];

  const selectWorkspace = (id: string | null) => {
    setWorkspaceId(id);
    if (id === null) localStorage.removeItem(currentWorkspaceKey);
    else localStorage.setItem(currentWorkspaceKey, id);
    setSelectedId(id === null ? null : "members");
  };

  return (
    <div className="workspace">
      <aside className="sidebar">
        <WorkspaceSwitcher {...teams} current={current} onSelect={(workspace) => selectWorkspace(workspace?.id ?? null)} />
        {current && (
          <button
            className={showMembers ? "bot-row selected" : "bot-row"}
            onClick={() => {
              setSelectedId("members");
              setMembersVisit(membersVisit + 1);
            }}
          >
            <span className="bot-name">Members</span>
            <span className="bot-status">{current.role}</span>
          </button>
        )}
        {current && (
          <button
            className={showConnectors ? "bot-row selected" : "bot-row"}
            onClick={() => {
              setSelectedId("connectors");
              setMembersVisit(membersVisit + 1);
            }}
          >
            <span className="bot-name">Connectors</span>
            <span className="bot-status">checklist</span>
          </button>
        )}
        {current && (
          <nav className="bot-list projects">
            {projects.map(({ id, name, repo }) => (
              <button key={id} className={id === project?.id ? "bot-row selected" : "bot-row"} onClick={() => setSelectedId(id)}>
                <span className="bot-name">{name}</span>
                <span className="bot-status">{repo.split("/")[0]}</span>
              </button>
            ))}
            <NewProject
              workspace={current}
              onCreated={(created) => {
                void reloadProjects();
                setSelectedId(created.id);
              }}
            />
          </nav>
        )}
        <NewBot onCreated={setSelectedId} />
        <nav className="bot-list">
          {bots.map((bot) => (
            <button
              key={bot.id}
              className={!showMembers && !showConnectors && !project && bot.id === selected?.id ? "bot-row selected" : "bot-row"}
              onClick={() => setSelectedId(bot.id)}
            >
              <StatusDot status={bot.status} />
              <span className="bot-name">{bot.name}</span>
              <span className="bot-status">{bot.status}</span>
            </button>
          ))}
        </nav>
        {user.needsGitHubSignIn && (
          <div className="github-notice">
            <p>GitHub sign-in needed. Your bots can't work until you sign in again.</p>
            <button onClick={() => void window.chiefbot.auth.signIn()}>Sign in again</button>
          </div>
        )}
        <footer className="sidebar-footer">
          <div className="account">
            <strong>{user.login}</strong>
            <span className="muted">
              Copilot: {user.copilotPlan ? `${user.copilotPlan.plan} (${user.copilotPlan.sku})` : "none"}
            </span>
          </div>
          <div className="account-actions">
            {!user.needsGitHubSignIn && (
              <button className="link-button" onClick={() => void window.chiefbot.auth.disconnectGitHub()}>
                Disconnect GitHub
              </button>
            )}
            <button className="link-button" onClick={() => void window.chiefbot.auth.signOut()}>
              Sign out
            </button>
          </div>
        </footer>
      </aside>
      <main className="pane">
        {showMembers ? (
          <Members
            key={`${current.id}:${membersVisit}`}
            workspace={current}
            user={user}
            onLeft={() => {
              selectWorkspace(null);
              void teams.reload();
            }}
          />
        ) : showConnectors ? (
          <Connectors key={`${current.id}:${membersVisit}`} workspace={current} />
        ) : project && current ? (
          <ProjectPane
            key={project.id}
            login={user.login}
            project={project}
            workspace={current}
            onDeleted={() => {
              setSelectedId(null);
              void reloadProjects();
            }}
          />
        ) : selected ? (
          <BotPane key={selected.id} bot={selected} />
        ) : (
          <p className="muted">Create a bot to start.</p>
        )}
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
            <button onClick={() => void stop(bot.id)} disabled={bot.status === "stopping"}>
              Stop
            </button>
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


const statusText: Record<BotStatus, string> = {
  starting: "Its computer is starting. The bot comes online when its worker connects.",
  online: "Online. Its worker is connected.",
  stopping: "Its computer is stopping. It takes no new messages, routine runs or screen viewers.",
  stopped: "Stopped. Its files are kept.",
};

// Colour per status, with a ping while starting or stopping (after T3 Code's ConnectionStatusDot).
function StatusDot({ status }: { status: BotStatus }) {
  return (
    <span className={`status-dot ${status}`} aria-label={status}>
      {(status === "starting" || status === "stopping") && <span className="ping" />}
      <span className="dot" />
    </span>
  );
}
