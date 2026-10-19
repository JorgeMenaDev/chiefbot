import { AuthState, Bot, type User } from "@chiefbot/contracts";
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  LogOutIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TriangleAlertIcon,
  UnplugIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { z } from "zod";
import { BotPane, StatusDot } from "./BotPane.tsx";
import { Connectors } from "./Connectors.tsx";
import { NewProject, ProjectPane, useProjects } from "./Projects.tsx";
import { Column, ErrorText, PaneHeader } from "./Pane.tsx";
import { Members, useWorkspaces, WorkspaceSwitcher } from "./Workspaces.tsx";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert.tsx";
import { Button, buttonVariants } from "./components/ui/button.tsx";
import { Card, CardDescription, CardHeader, CardPanel } from "./components/ui/card.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty.tsx";
import { Input } from "./components/ui/input.tsx";
import { MenuItem, MenuPopup, MenuSeparator } from "./components/ui/menu.tsx";
import {
  Sidebar,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarIconButton,
  SidebarLayout,
  SidebarRow,
  SidebarSearch,
  useSidebarOpen,
} from "./components/ui/sidebar.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { copyText } from "./lib/clipboard.ts";
import appIcon from "../../../../../docs/brand/icon.svg";
import glyph from "../../../../../docs/brand/glyph.svg";

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
  // A centred card, like T3 Code's empty states.
  return (
    <main className="relative flex h-full items-center justify-center p-6">
      <div className="drag-region absolute inset-x-0 top-0 h-(--topbar-height)" />
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center pb-5 text-center">
          <img src={appIcon} alt="" className="mb-1 size-20" />
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

// T3 Code's layout: a sidebar of bots on the left, the selected bot's chat in the
// middle and its details panel on the right. The sidebar hides with its toggle or Cmd+B.
// The switcher on top picks the current workspace, whose members screen and
// projects open from the sidebar. Bots are personal, so the bot list is the same
// in every workspace.
function Workspace({ user }: { user: User }) {
  const bots = useBots();
  const teams = useWorkspaces();
  const sidebar = useSidebarOpen();
  const [workspaceId, setWorkspaceId] = useState(() => localStorage.getItem(currentWorkspaceKey));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumped by each click on Members or Connectors, which remounts (reloads) the
  // screen: control sends no member or connector events.
  const [membersVisit, setMembersVisit] = useState(0);
  // Whether the sidebar's new-bot and new-project forms are open. Each is its own,
  // so one finishing never closes the other.
  const [creatingBot, setCreatingBot] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  // The search row filters the sidebar's projects and bots by name.
  const [query, setQuery] = useState("");
  const current = teams.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const { projects, reload: reloadProjects } = useProjects(current);
  const showMembers = current !== null && selectedId === "members";
  const showConnectors = current !== null && selectedId === "connectors";
  const project = projects.find(({ id }) => id === selectedId);
  const selected = bots.find((bot) => bot.id === selectedId) ?? bots[0];
  const searching = query.trim() !== "";
  const matches = (...names: string[]) => names.some((name) => name.toLowerCase().includes(query.trim().toLowerCase()));
  const shownProjects = projects.filter(({ name, repo }) => matches(name, repo));
  const shownBots = bots.filter(({ name }) => matches(name));

  const selectWorkspace = (id: string | null) => {
    setWorkspaceId(id);
    if (id === null) localStorage.removeItem(currentWorkspaceKey);
    else localStorage.setItem(currentWorkspaceKey, id);
    setSelectedId(id === null ? null : "members");
  };

  return (
    <SidebarLayout open={sidebar.open} onToggle={sidebar.toggle}>
      <Sidebar open={sidebar.open}>
        <SidebarHeader>
          <img src={glyph} alt="" className="size-5" />
          Chiefbot
        </SidebarHeader>
        <div className="flex shrink-0 flex-col gap-1 px-2 pb-1">
          <WorkspaceSwitcher {...teams} current={current} onSelect={(workspace) => selectWorkspace(workspace?.id ?? null)} />
          <div className="flex items-center gap-0.5">
            <SidebarSearch icon={<SearchIcon />} placeholder="Search" aria-label="Search projects and bots" value={query} onChange={(event) => setQuery(event.target.value)} />
            {current && (
              <SidebarIconButton label="New project" onClick={() => setCreatingProject(true)}>
                <FolderPlusIcon />
              </SidebarIconButton>
            )}
            <SidebarIconButton label="New bot" onClick={() => setCreatingBot(true)}>
              <SquarePenIcon />
            </SidebarIconButton>
          </div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
          {current && !searching && (
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
            </>
          )}
          {current && (shownProjects.length > 0 || !searching || creatingProject) && (
            <>
              <SidebarGroupLabel>Projects</SidebarGroupLabel>
              {shownProjects.map(({ id, name, repo }) => (
                <SidebarRow key={id} active={id === project?.id} onClick={() => setSelectedId(id)}>
                  <FolderGit2Icon />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <RowNote>{repo.split("/")[0]}</RowNote>
                </SidebarRow>
              ))}
              {creatingProject ? (
                <NewProject
                  workspace={current}
                  onClose={() => setCreatingProject(false)}
                  onCreated={(created) => {
                    void reloadProjects();
                    setSelectedId(created.id);
                  }}
                />
              ) : (
                projects.length === 0 && <NewRow label="New project" onClick={() => setCreatingProject(true)} />
              )}
            </>
          )}
          {(shownBots.length > 0 || !searching || creatingBot) && (
            <>
              <SidebarGroupLabel>Bots</SidebarGroupLabel>
              {shownBots.map((bot) => (
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
              {creatingBot ? (
                <NewBot onCreated={setSelectedId} onClose={() => setCreatingBot(false)} />
              ) : (
                bots.length === 0 && <NewRow label="New bot" onClick={() => setCreatingBot(true)} />
              )}
            </>
          )}
          {searching && shownProjects.length === 0 && shownBots.length === 0 && !creatingBot && !creatingProject && (
            <p className="px-2.5 py-2 text-sidebar-muted-foreground text-xs">No projects or bots match.</p>
          )}
        </nav>
        {user.needsGitHubSignIn && (
          <div className="shrink-0 px-2 pb-1">
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
        <footer className="flex shrink-0 items-center px-2 pt-1 pb-2">
          <SettingsMenu user={user} />
        </footer>
      </Sidebar>
      <main className="flex min-w-0 flex-1">
        {showMembers ? (
          <Column>
            <Members
              key={`${current.id}:${membersVisit}`}
              workspace={current}
              user={user}
              onLeft={() => {
                selectWorkspace(null);
                void teams.reload();
              }}
            />
          </Column>
        ) : showConnectors ? (
          <Column>
            <Connectors key={`${current.id}:${membersVisit}`} workspace={current} />
          </Column>
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
          <Column>
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
          </Column>
        )}
      </main>
    </SidebarLayout>
  );
}

// Bottom left, after T3 Code's settings button: a menu with the signed-in GitHub
// user and their Copilot plan, Disconnect GitHub and Sign out. The menu sits in the
// top layer, so it is never clipped, whatever the window's height.
function SettingsMenu({ user }: { user: User }) {
  const menu = "settings-menu";
  const { disconnectGitHub, signOut } = window.chiefbot.auth;
  return (
    <>
      <SidebarIconButton label="Settings" popoverTarget={menu}>
        <SettingsIcon />
      </SidebarIconButton>
      <MenuPopup id={menu} aria-label="Account" className="w-60">
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted font-medium text-sm uppercase">
            {user.login.slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-sm">{user.login}</div>
            <div className="break-words text-muted-foreground text-xs">
              Copilot: {user.copilotPlan ? `${user.copilotPlan.plan} (${user.copilotPlan.sku})` : "none"}
            </div>
          </div>
        </div>
        <MenuSeparator />
        {!user.needsGitHubSignIn && (
          <MenuItem menu={menu} onClick={() => void disconnectGitHub()}>
            <UnplugIcon />
            Disconnect GitHub
          </MenuItem>
        )}
        <MenuItem menu={menu} onClick={() => void signOut()}>
          <LogOutIcon />
          Sign out
        </MenuItem>
      </MenuPopup>
    </>
  );
}

// The quiet "+ New …" row an empty section shows; the search row's icons open the same form.
function NewRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <SidebarRow className="text-sidebar-muted-foreground" onClick={onClick}>
      <PlusIcon />
      <span>{label}</span>
    </SidebarRow>
  );
}

// A sidebar row's quiet trailing note (a status, a role, a repo owner).
function RowNote({ children }: { children: ReactNode }) {
  return <span className="shrink-0 font-normal text-sidebar-muted-foreground text-xs">{children}</span>;
}

// The sidebar's new-bot form. Escape or a made bot closes it (`onClose`).
function NewBot({ onCreated, onClose }: { onCreated: (id: string) => void; onClose: () => void }) {
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
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
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
        onKeyDown={(event) => event.key === "Escape" && onClose()}
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
