import { AuthState, Bot, type BotStatus, type User } from "@chiefbot/contracts";
import { BotIcon, CheckIcon, CopyIcon, FolderGit2Icon, ListChecksIcon, LogOutIcon, PlugIcon, PlusIcon, PowerIcon, PowerOffIcon, Trash2Icon, TriangleAlertIcon, UnplugIcon, UsersIcon, XIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { z } from "zod";
import { Chat } from "./Chat.tsx";
import { Connectors } from "./Connectors.tsx";
import { Routines } from "./Routines.tsx";
import { ScreenPane } from "./LiveScreen.tsx";
import { NewProject, ProjectPane, useProjects } from "./Projects.tsx";
import { ErrorText, PaneHeader } from "./Pane.tsx";
import { Members, useWorkspaces, WorkspaceSwitcher } from "./Workspaces.tsx";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert.tsx";
import { Button, buttonVariants } from "./components/ui/button.tsx";
import { Card, CardDescription, CardHeader, CardPanel } from "./components/ui/card.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty.tsx";
import { Input } from "./components/ui/input.tsx";
import { SidebarGroupLabel, SidebarRow } from "./components/ui/sidebar.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { copyText } from "./lib/clipboard.ts";
import { cn } from "./lib/utils.ts";

const BotList = z.array(Bot);

// macOS draws its window buttons over the sidebar's top bar, so the brand starts after them.
const isMac = navigator.userAgent.includes("Mac");

// Signed out: the sign-in screen. Signed in: the bot sidebar and the selected bot.
export function App() {
  const [state, setState] = useState<AuthState | null>(null);

  useEffect(() => {
    const unsubscribe = window.chiefbot.auth.onChange((next) => setState(AuthState.parse(next)));
    void window.chiefbot.auth.get().then((next) => setState(AuthState.parse(next)));
    return unsubscribe;
  }, []);

  if (state?.status === "signed-in") return <Workspace user={state.user} />;
  // A centred card, like T3 Code's empty states.
  return (
    <main className="relative flex h-full items-center justify-center p-6">
      <div className="drag-region absolute inset-x-0 top-0 h-(--topbar-height)" />
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center pb-5 text-center">
          <EmptyMedia className="mb-3">
            <BotIcon />
          </EmptyMedia>
          <h1 className="font-semibold text-xl">Chiefbot</h1>
          <CardDescription>Bots with their own computers, on your GitHub Copilot plan.</CardDescription>
        </CardHeader>
        <CardPanel className="flex flex-col gap-3">{state ? <AuthPanel state={state} /> : <Spinner className="mx-auto size-4 text-muted-foreground" />}</CardPanel>
      </Card>
    </main>
  );
}

function AuthPanel({ state }: { state: Exclude<AuthState, { status: "signed-in" }> }) {
  const { signIn } = window.chiefbot.auth;
  switch (state.status) {
    case "signed-out":
      return (
        <Button size="lg" className="w-full" onClick={() => void signIn()}>
          <GitHubMark />
          Sign in with GitHub
        </Button>
      );
    case "waiting-for-code":
      return (
        <>
          <p className="text-center text-muted-foreground text-sm">Enter this code on GitHub:</p>
          <DeviceCode code={state.userCode} />
          <a className={buttonVariants({ size: "lg", className: "w-full" })} href={state.verificationUri} target="_blank" rel="noreferrer">
            <GitHubMark />
            Open {state.verificationUri.replace(/^https?:\/\//, "")}
          </a>
          <p className="flex items-center justify-center gap-2 text-muted-foreground text-xs">
            <Spinner className="size-3.5" />
            Waiting for you to approve it on GitHub
          </p>
        </>
      );
    case "error":
      return (
        <>
          <Alert variant="error">
            <TriangleAlertIcon />
            <AlertTitle>Sign-in failed</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
          <Button size="lg" className="w-full" onClick={() => void signIn()}>
            Try again
          </Button>
        </>
      );
  }
}

// The device code with a Copy button (after T3 Code's MessageCopyButton). The
// button says "Copied" for two seconds. A failed copy stays shown, with a line
// asking the user to select the code (one click selects it whole), until a retry works.
function DeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (copied !== true) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 rounded-xl border bg-background py-2.5 ps-4 pe-2.5 dark:bg-input/32">
        <code className="flex-1 select-all text-center font-mono font-semibold text-2xl tracking-[0.2em]">{code}</code>
        <Button size="sm" variant="outline" aria-live="polite" onClick={() => void copyText(code, navigator.clipboard).then(setCopied)}>
          {copied === true ? <CheckIcon className="text-success" /> : copied === false ? <XIcon className="text-destructive" /> : <CopyIcon />}
          {copied === true ? "Copied" : copied === false ? "Copy failed" : "Copy"}
        </Button>
      </div>
      {copied === false && <p className="text-center text-destructive-foreground text-xs">Copy failed, select the code and copy it.</p>}
    </div>
  );
}

// GitHub's mark (GitHub's Octicons, MIT).
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="fill-current" aria-hidden="true">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
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
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground">
        <div className={cn("drag-region flex h-(--topbar-height) shrink-0 items-center px-4", isMac && "ps-[84px]")}>
          <span className="font-semibold text-sm tracking-tight">Chiefbot</span>
        </div>
        <div className="px-2 pb-1">
          <WorkspaceSwitcher {...teams} current={current} onSelect={(workspace) => selectWorkspace(workspace?.id ?? null)} />
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
          {current && (
            <>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarRow
                active={showMembers}
                onClick={() => {
                  setSelectedId("members");
                  setMembersVisit(membersVisit + 1);
                }}
              >
                <UsersIcon />
                <span className="min-w-0 flex-1 truncate">Members</span>
                <RowNote>{current.role}</RowNote>
              </SidebarRow>
              <SidebarRow
                active={showConnectors}
                onClick={() => {
                  setSelectedId("connectors");
                  setMembersVisit(membersVisit + 1);
                }}
              >
                <PlugIcon />
                <span className="min-w-0 flex-1 truncate">Connectors</span>
                <RowNote>checklist</RowNote>
              </SidebarRow>
              <SidebarGroupLabel>Projects</SidebarGroupLabel>
              {projects.map(({ id, name, repo }) => (
                <SidebarRow key={id} active={id === project?.id} onClick={() => setSelectedId(id)}>
                  <FolderGit2Icon />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <RowNote>{repo.split("/")[0]}</RowNote>
                </SidebarRow>
              ))}
              <NewProject
                workspace={current}
                onCreated={(created) => {
                  void reloadProjects();
                  setSelectedId(created.id);
                }}
              />
            </>
          )}
          <SidebarGroupLabel>Bots</SidebarGroupLabel>
          {bots.map((bot) => (
            <SidebarRow
              key={bot.id}
              active={!showMembers && !showConnectors && !project && bot.id === selected?.id}
              onClick={() => setSelectedId(bot.id)}
            >
              <StatusDot status={bot.status} />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              <RowNote>{bot.status}</RowNote>
            </SidebarRow>
          ))}
          <NewBot onCreated={setSelectedId} />
        </nav>
        {user.needsGitHubSignIn && (
          <div className="px-2 pb-2">
            <Alert variant="warning" className="text-xs">
              <TriangleAlertIcon />
              <AlertTitle>GitHub sign-in needed</AlertTitle>
              <AlertDescription className="gap-2">
                Your bots can't work until you sign in again.
                <Button size="xs" variant="outline" className="self-start" onClick={() => void window.chiefbot.auth.signIn()}>
                  Sign in again
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}
        <footer className="flex flex-col gap-0.5 border-sidebar-border border-t p-2">
          <div className="flex items-center gap-2.5 px-1.5 py-1">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-row-active font-medium text-xs uppercase">
              {user.login.slice(0, 1)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">{user.login}</div>
              <div className="truncate text-sidebar-muted-foreground text-xs">
                Copilot: {user.copilotPlan ? `${user.copilotPlan.plan} (${user.copilotPlan.sku})` : "none"}
              </div>
            </div>
            <Button size="icon-sm" variant="ghost" aria-label="Sign out" title="Sign out" onClick={() => void window.chiefbot.auth.signOut()}>
              <LogOutIcon />
            </Button>
          </div>
          {!user.needsGitHubSignIn && (
            <Button
              size="xs"
              variant="ghost"
              className="justify-start text-sidebar-muted-foreground"
              onClick={() => void window.chiefbot.auth.disconnectGitHub()}
            >
              <UnplugIcon />
              Disconnect GitHub
            </Button>
          )}
        </footer>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
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
          <>
            <PaneHeader title="Chiefbot" />
            <Empty>
              <EmptyHeader>
                <EmptyMedia>
                  <BotIcon />
                </EmptyMedia>
                <EmptyTitle>No bots yet</EmptyTitle>
                <EmptyDescription>Create a bot to start.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </>
        )}
      </main>
    </div>
  );
}

// A sidebar row's quiet trailing note (a status, a role, a repo owner).
function RowNote({ children }: { children: ReactNode }) {
  return <span className="shrink-0 font-normal text-sidebar-muted-foreground text-xs">{children}</span>;
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
      <SidebarRow className="text-sidebar-muted-foreground" onClick={() => setOpen(true)}>
        <PlusIcon />
        <span>New bot</span>
      </SidebarRow>
    );
  }
  return (
    <form className="flex flex-col gap-1.5 px-0.5 py-1" onSubmit={(event) => void submit(event)}>
      <Input
        autoFocus
        placeholder="Bot name"
        value={name}
        maxLength={60}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
      />
      {busy && (
        <p className="flex items-center gap-1.5 px-1 text-muted-foreground text-xs">
          <Spinner className="size-3" />
          Starting its computer…
        </p>
      )}
      <ErrorText message={error} />
    </form>
  );
}

// The selected bot: its controls, with its live screen in a side pane.
function BotPane({ bot }: { bot: Bot }) {
  const { start, stop, remove } = window.chiefbot.bots;
  const [showRoutines, setShowRoutines] = useState(false);
  return (
    <>
      <PaneHeader icon={<StatusDot status={bot.status} />} title={bot.name} note={`${statusText[bot.status]} · runs on your Copilot seat`}>
        {bot.status === "stopped" ? (
          <Button size="xs" variant="outline" onClick={() => void start(bot.id)}>
            <PowerIcon />
            Start
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={() => void stop(bot.id)} disabled={bot.status === "stopping"}>
            <PowerOffIcon />
            Stop
          </Button>
        )}
        <Button size="xs" variant="outline" pressed={showRoutines} onClick={() => setShowRoutines(!showRoutines)}>
          <ListChecksIcon />
          Routines
        </Button>
        <Button size="xs" variant="destructive-outline" onClick={() => void remove(bot.id)}>
          <Trash2Icon />
          Delete
        </Button>
      </PaneHeader>
      {showRoutines && <Routines bot={bot} />}
      <div className="flex min-h-0 flex-1">
        <Chat bot={bot} />
        <ScreenPane bot={bot} />
      </div>
    </>
  );
}

const statusText: Record<BotStatus, string> = {
  starting: "Its computer is starting. The bot comes online when its worker connects.",
  online: "Online. Its worker is connected.",
  stopping: "Its computer is stopping. It takes no new messages, routine runs or screen viewers.",
  stopped: "Stopped. Its files are kept.",
};

// Colour per status, with a ping while starting or stopping (after T3 Code's ConnectionStatusDot).
const dotColor: Record<BotStatus, string> = {
  online: "bg-success",
  starting: "bg-warning",
  stopping: "bg-muted-foreground/40",
  stopped: "bg-muted-foreground/40",
};
const pingColor: Record<BotStatus, string | null> = {
  online: null,
  starting: "bg-warning/60",
  stopping: "bg-muted-foreground/30",
  stopped: null,
};

function StatusDot({ status }: { status: BotStatus }) {
  const ping = pingColor[status];
  return (
    <span className="relative flex size-3 shrink-0 items-center justify-center" aria-label={status}>
      {ping && <span className={cn("absolute inline-flex size-full animate-status-ping rounded-full", ping)} />}
      <span className={cn("relative inline-flex size-2 rounded-full", dotColor[status])} />
    </span>
  );
}
