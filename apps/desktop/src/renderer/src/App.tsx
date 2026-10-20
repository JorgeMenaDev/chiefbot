import { AuthState, Bot, ProjectId, type User } from "@chiefbot/contracts";
import {
  ActivityIcon,
  BlocksIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  FolderGit2Icon,
  LogOutIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TriangleAlertIcon,
  UnplugIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { BotFace, BotPane } from "./BotPane.tsx";
import { ConnectApps } from "./ConnectApps.tsx";
import { Connectors } from "./Connectors.tsx";
import { Health } from "./Health.tsx";
import { Settings } from "./Settings.tsx";
import { NewBot } from "./NewBot.tsx";
import { NewProject, ProjectList, useProjectStates, type ProjectView } from "./ProjectList.tsx";
import { ProjectPane, useProjects } from "./Projects.tsx";
import { Column, PaneHeader, PaneShown } from "./Pane.tsx";
import { Members, useWorkspaces } from "./Workspaces.tsx";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert.tsx";
import { Button, buttonVariants } from "./components/ui/button.tsx";
import { Card, CardDescription, CardHeader, CardPanel } from "./components/ui/card.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty.tsx";
import { MenuItem, MenuPopup, MenuSeparator } from "./components/ui/menu.tsx";
import {
  isMac,
  Sidebar,
  SidebarHeader,
  SidebarIconButton,
  SidebarLayout,
  SidebarNewRow,
  SidebarRow,
  SidebarRowNote,
  SidebarSearch,
  useSidebarOpen,
} from "./components/ui/sidebar.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { TabPanel, Tabs, useTabIds, type TabItem } from "./components/ui/tabs.tsx";
import { copyText } from "./lib/clipboard.ts";
import { tabForShortcut, type AppTab } from "./lib/appTabs.ts";
import appIcon from "../../../../../docs/brand/icon.svg";
import glyph from "../../../../../docs/brand/glyph.svg";

const BotList = z.array(Bot);

// Signed out: the sign-in screen. Signed in: the sidebar (Bots | Projects) and what it selects.
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

// The current workspace and the open tab survive a restart; no workspace means "Personal".
const currentWorkspaceKey = "chiefbot.workspace";
const tabKey = "chiefbot.tab";

// What the main column shows instead of either tab: the person's own screens,
// opened from the sidebar's footer in any tab.
type Screen = "connect-apps" | "health" | "settings";

// T3 Code's layout: a sidebar on the left, the selected chat in the middle and its
// panel on the right. The sidebar hides with its toggle or Cmd+B. Its two tabs,
// Bots | Projects (Cmd+1, Cmd+2), each keep their own selection, and both panes
// stay mounted, so a draft in one survives a visit to the other. Bots are
// personal; Projects shows the current workspace's, with its Members and Connectors.
function Workspace({ user }: { user: User }) {
  const bots = useBots();
  const teams = useWorkspaces();
  const sidebar = useSidebarOpen();
  const states = useProjectStates();
  const tabIds = useTabIds<AppTab>();
  const [tab, setTab] = useState<AppTab>(() => (localStorage.getItem(tabKey) === "projects" ? "projects" : "bots"));
  const [workspaceId, setWorkspaceId] = useState(() => localStorage.getItem(currentWorkspaceKey));
  const [botId, setBotId] = useState<string | null>(null);
  const [projectView, setProjectView] = useState<ProjectView | null>(null);
  const [screen, setScreen] = useState<Screen | null>(null);
  // Bumped by each click on Members, Connectors, Connect apps or Health, which remounts
  // (reloads) the screen: control sends no member, connector or health events.
  const [visit, setVisit] = useState(0);
  const [creatingBot, setCreatingBot] = useState(false);
  // The dialog hands focus back to what opened it, but the empty list's New bot row is
  // gone by then, so focus lands on the search row's New bot button instead.
  const newBotButton = useRef<HTMLButtonElement>(null);
  const closeNewBot = () => {
    flushSync(() => setCreatingBot(false));
    newBotButton.current?.focus();
  };
  // The search row filters the bots by name.
  const [query, setQuery] = useState("");
  const current = teams.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const { projects, reload: reloadProjects } = useProjects(current);
  const selected = bots.find((bot) => bot.id === botId) ?? bots[0];
  const shownBots = bots.filter(({ name }) => name.toLowerCase().includes(query.trim().toLowerCase()));
  // The Projects tab shows Members, Connectors, or a project: the one picked, else the first.
  const workspaceScreen = current && (projectView === "members" || projectView === "connectors") ? projectView : null;
  const project = workspaceScreen ? undefined : (projects.find(({ id }) => id === projectView) ?? projects[0]);

  const openTab = (next: AppTab) => {
    setTab(next);
    setScreen(null);
    localStorage.setItem(tabKey, next);
  };
  const openScreen = (next: Screen) => {
    setScreen(next);
    setVisit((count) => count + 1);
  };
  // Cmd+1 and Cmd+2 (Ctrl off macOS), claimed before anything else sees them,
  // as a live screen under Take control would send them on.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const next = event.defaultPrevented || event.repeat ? null : tabForShortcut(event, isMac);
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      openTab(next);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Ask my bot (Health): the bot selected in the Bots tab opens with the problem
  // in its composer. The draft goes once the user picks another bot.
  const [askDraft, setAskDraft] = useState<{ botId: string; text: string } | null>(null);
  useEffect(() => {
    if (askDraft && selected?.id !== askDraft.botId) setAskDraft(null);
  }, [selected?.id]);
  const askBot = (text: string) => {
    if (!selected) return;
    setAskDraft({ botId: selected.id, text });
    openTab("bots");
  };

  const selectWorkspace = (id: string | null) => {
    setWorkspaceId(id);
    if (id === null) localStorage.removeItem(currentWorkspaceKey);
    else localStorage.setItem(currentWorkspaceKey, id);
    setProjectView(null);
  };
  // A handoff card's Open in Projects: the project, in its workspace.
  const openProject = ({ workspaceId: workspace, projectId }: { workspaceId: string; projectId: string }) => {
    selectWorkspace(workspace);
    setProjectView(ProjectId.parse(projectId));
    openTab("projects");
  };
  const tabs: Array<TabItem<AppTab>> = [
    { key: "bots", label: "Bots", title: `Bots (${isMac ? "⌘" : "Ctrl+"}1)` },
    {
      key: "projects",
      label: "Projects",
      title: `Projects (${isMac ? "⌘" : "Ctrl+"}2)`,
      note: Object.values(states).includes("needs_you") && <span role="img" aria-label="needs you" className="size-1.5 rounded-full bg-warning" />,
    },
  ];

  return (
    <SidebarLayout open={sidebar.open} onToggle={sidebar.toggle}>
      <Sidebar open={sidebar.open}>
        <SidebarHeader>
          <img src={glyph} alt="" className="size-5" />
          Chiefbot
        </SidebarHeader>
        <div className="shrink-0 px-2 pb-2">
          <Tabs label="Bots and projects" tabs={tabs} value={tab} ids={tabIds} onChange={openTab} />
        </div>
        <TabPanel ids={tabIds} tab="bots" value={tab} className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-0.5 px-2 pb-1">
            <SidebarSearch icon={<SearchIcon />} placeholder="Search bots" aria-label="Search bots" value={query} onChange={(event) => setQuery(event.target.value)} />
            <SidebarIconButton ref={newBotButton} label="New bot" onClick={() => setCreatingBot(true)}>
              <SquarePenIcon />
            </SidebarIconButton>
          </div>
          <nav aria-label="Bots" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
            {shownBots.map((bot) => (
              <SidebarRow
                key={bot.id}
                active={screen === null && bot.id === selected?.id}
                onClick={() => {
                  setBotId(bot.id);
                  setScreen(null);
                }}
              >
                <BotFace bot={bot} className="size-4.5" dotClassName="-end-1 -bottom-1 scale-75 bg-sidebar" />
                <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                <SidebarRowNote>{bot.status}</SidebarRowNote>
              </SidebarRow>
            ))}
            {creatingBot ? (
              <NewBot
                onCreated={(id) => {
                  setBotId(id);
                  setScreen(null);
                }}
                onClose={closeNewBot}
              />
            ) : (
              bots.length === 0 && <SidebarNewRow label="New bot" onClick={() => setCreatingBot(true)} />
            )}
            {shownBots.length === 0 && bots.length > 0 && !creatingBot && <p className="px-2.5 py-2 text-sidebar-muted-foreground text-xs">No bots match.</p>}
          </nav>
        </TabPanel>
        <TabPanel ids={tabIds} tab="projects" value={tab} className="flex min-h-0 flex-1 flex-col">
          <ProjectList
            teams={teams}
            current={current}
            onWorkspace={(workspace) => selectWorkspace(workspace?.id ?? null)}
            projects={projects}
            states={states}
            view={screen === null ? (workspaceScreen ?? project?.id ?? null) : null}
            onView={(view) => {
              setProjectView(view);
              setScreen(null);
              setVisit((count) => count + 1);
            }}
            onCreated={(created) => {
              void reloadProjects();
              setProjectView(created.id);
              setScreen(null);
            }}
          />
        </TabPanel>
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
        {/* A row of icons, after T3 Code's `SidebarUtilityMenu`: the gear menu, then Health. */}
        <footer className="flex shrink-0 items-center gap-1 px-2 pt-1 pb-2">
          <SettingsMenu user={user} onConnectApps={() => openScreen("connect-apps")} onSettings={() => openScreen("settings")} />
          <SidebarIconButton label="Health" active={screen === "health"} onClick={() => openScreen("health")}>
            <ActivityIcon />
          </SidebarIconButton>
        </footer>
      </Sidebar>
      <main className="flex min-w-0 flex-1">
        {screen === "connect-apps" ? (
          <Column>
            <ConnectApps key={visit} />
          </Column>
        ) : screen === "health" ? (
          <Column>
            <Health key={visit} onConnectApps={() => openScreen("connect-apps")} onAsk={bots.length > 0 ? askBot : null} />
          </Column>
        ) : screen === "settings" ? (
          <Column>
            <Settings />
          </Column>
        ) : (
          <>
            {/* Both tabs stay mounted, the other one hidden, so each keeps its drafts. */}
            <div hidden={tab !== "bots"} className="flex min-w-0 flex-1">
              {selected ? (
                <BotPane
                  key={selected.id}
                  bot={selected}
                  away={tab !== "bots"}
                  draft={askDraft?.botId === selected.id ? askDraft.text : undefined}
                  onOpenProject={openProject}
                />
              ) : (
                <EmptyPane title="Chiefbot" icon={<BotIcon />} heading="No bots yet" text="Create a bot to start." />
              )}
            </div>
            <div hidden={tab !== "projects"} className="flex min-w-0 flex-1">
              <PaneShown value={tab === "projects"}>
                {!current ? (
                  <EmptyPane title="Projects" icon={<UsersIcon />} heading="Projects live in a workspace" text="Pick a workspace in the sidebar, or make one. Then add a repo." />
                ) : workspaceScreen === "members" ? (
                  <Column>
                    <Members
                      key={`${current.id}:${visit}`}
                      workspace={current}
                      user={user}
                      onLeft={() => {
                        selectWorkspace(null);
                        void teams.reload();
                      }}
                    />
                  </Column>
                ) : workspaceScreen === "connectors" ? (
                  <Column>
                    <Connectors key={`${current.id}:${visit}`} workspace={current} />
                  </Column>
                ) : project ? (
                  <ProjectPane
                    key={project.id}
                    login={user.login}
                    project={project}
                    workspace={current}
                    onDeleted={() => {
                      setProjectView(null);
                      void reloadProjects();
                    }}
                    onChanged={() => void reloadProjects()}
                  />
                ) : (
                  <EmptyPane title={current.name} icon={<FolderGit2Icon />} heading="No projects yet" text="Add a repo. Your bots can then hand work to it.">
                    <NewProject
                      workspace={current}
                      onCreated={(created) => {
                        void reloadProjects();
                        setProjectView(created.id);
                      }}
                    />
                  </EmptyPane>
                )}
              </PaneShown>
            </div>
          </>
        )}
      </main>
    </SidebarLayout>
  );
}

// A main column with nothing to show yet: its top bar, then a centred line, and
// what starts it (`children`).
function EmptyPane({ title, icon, heading, text, children }: { title: string; icon: ReactNode; heading: string; text: string; children?: ReactNode }) {
  return (
    <Column>
      <PaneHeader title={title} />
      <Empty>
        <EmptyHeader>
          <EmptyMedia>{icon}</EmptyMedia>
          <EmptyTitle>{heading}</EmptyTitle>
          <EmptyDescription>{text}</EmptyDescription>
        </EmptyHeader>
        {children}
      </Empty>
    </Column>
  );
}

// Bottom left, after T3 Code's settings button: a menu with the signed-in GitHub
// user and their Copilot plan, Connect apps, Settings, Disconnect GitHub and Sign out. The
// menu sits in the top layer, so it is never clipped, whatever the window's height.
function SettingsMenu({ user, onConnectApps, onSettings }: { user: User; onConnectApps: () => void; onSettings: () => void }) {
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
        <MenuItem menu={menu} onClick={onConnectApps}>
          <BlocksIcon />
          <span className="flex flex-col">
            Connect apps
            <span className="text-muted-foreground text-xs">Tools and skills for your Chief of Staff</span>
          </span>
        </MenuItem>
        <MenuItem menu={menu} onClick={onSettings}>
          <SettingsIcon />
          Settings
        </MenuItem>
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
