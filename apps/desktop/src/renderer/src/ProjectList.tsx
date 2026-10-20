import { CreateProjectRequest, Project, ProjectStates, type ProjectId, type ProjectState, type Workspace } from "@chiefbot/contracts";
import { FolderPlusIcon, PlugIcon, SearchIcon, UsersIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ErrorText } from "./Pane.tsx";
import { WorkspaceSwitcher, type useWorkspaces } from "./Workspaces.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { SidebarGroupLabel, SidebarIconButton, SidebarNewRow, SidebarRow, SidebarRowNote, SidebarSearch } from "./components/ui/sidebar.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { cn } from "./lib/utils.ts";

// The user's state of every project of their workspaces: what Electron main has
// kept, then all of them again on every change. Each replaces the last, so a
// project that went loses its dot.
export function useProjectStates() {
  const [states, setStates] = useState<ProjectStates>({});
  useEffect(() => {
    const unsubscribe = window.chiefbot.projects.onStates((next) => setStates(ProjectStates.parse(next)));
    void window.chiefbot.projects.states().then((kept) => setStates(ProjectStates.parse(kept)));
    return unsubscribe;
  }, []);
  return states;
}

// What the Projects tab shows in the main column: a project, or a screen of the workspace.
export type ProjectView = ProjectId | "members" | "connectors";

// The Projects tab of the sidebar: the workspace switcher, the workspace's
// Members and Connectors, and its projects with their state dots, which the
// search row filters. New project (the folder icon, or the empty list's row)
// opens a one-field form in the list.
export function ProjectList({
  teams,
  current,
  onWorkspace,
  projects,
  states,
  view,
  onView,
  onCreated,
}: {
  teams: ReturnType<typeof useWorkspaces>;
  current: Workspace | null;
  onWorkspace: (workspace: Workspace | null) => void;
  projects: Project[];
  states: ProjectStates;
  // What the main column shows, so its row is highlighted.
  view: ProjectView | null;
  onView: (view: ProjectView) => void;
  onCreated: (project: Project) => void;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const searching = query.trim() !== "";
  const shown = projects.filter(({ name, repo }) => [name, repo].some((text) => text.toLowerCase().includes(query.trim().toLowerCase())));
  return (
    <>
      <div className="flex shrink-0 flex-col gap-1 px-2 pb-1">
        <WorkspaceSwitcher {...teams} current={current} onSelect={onWorkspace} />
        <div className="flex items-center gap-0.5">
          <SidebarSearch icon={<SearchIcon />} placeholder="Search projects" aria-label="Search projects" value={query} onChange={(event) => setQuery(event.target.value)} />
          {current && (
            <SidebarIconButton label="New project" onClick={() => setCreating(true)}>
              <FolderPlusIcon />
            </SidebarIconButton>
          )}
        </div>
      </div>
      <nav aria-label="Projects" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {!current && <p className="px-2.5 py-2 text-sidebar-muted-foreground text-xs">Projects live in a workspace. Pick or make one above.</p>}
        {current && !searching && (
          <>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarRow active={view === "members"} onClick={() => onView("members")}>
              <UsersIcon />
              <span className="min-w-0 flex-1 truncate">Members</span>
              <SidebarRowNote>{current.role}</SidebarRowNote>
            </SidebarRow>
            <SidebarRow active={view === "connectors"} onClick={() => onView("connectors")}>
              <PlugIcon />
              <span className="min-w-0 flex-1 truncate">Connectors</span>
              <SidebarRowNote>checklist</SidebarRowNote>
            </SidebarRow>
          </>
        )}
        {current && (
          <>
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            {shown.map(({ id, name, repo }) => (
              <ProjectRow key={id} id={id} name={name} repo={repo} state={states[id]} active={id === view} onSelect={onView} />
            ))}
            {creating ? (
              <NewProject
                workspace={current}
                compact
                onClose={() => setCreating(false)}
                onCreated={(project) => {
                  setCreating(false);
                  onCreated(project);
                }}
              />
            ) : (
              projects.length === 0 && <SidebarNewRow label="New project" onClick={() => setCreating(true)} />
            )}
            {searching && shown.length === 0 && !creating && <p className="px-2.5 py-2 text-sidebar-muted-foreground text-xs">No projects match.</p>}
          </>
        )}
      </nav>
    </>
  );
}

// How each state shows: its dot (after a bot's: green while up, a ping while busy),
// what a screen reader says, and the row's note (idle shows the repo's owner).
const stateLook: Record<ProjectState, { dot: string; ping?: string; label: string; note?: string }> = {
  idle: { dot: "bg-success", label: "Idle" },
  working: { dot: "bg-success", ping: "bg-success/60", label: "Working", note: "working" },
  needs_you: { dot: "bg-warning", label: "Needs you", note: "needs you" },
  sleeping: { dot: "bg-muted-foreground/40", label: "Sleeping", note: "sleeping" },
};

// One project in the list: its state dot, its name and a quiet note. `state` is
// undefined until control has said it.
export function ProjectRow({
  id,
  name,
  repo,
  state,
  active,
  onSelect,
}: {
  id: ProjectId;
  name: string;
  repo: string;
  state: ProjectState | undefined;
  active: boolean;
  onSelect: (id: ProjectId) => void;
}) {
  const look = state && stateLook[state];
  return (
    <SidebarRow active={active} title={repo} onClick={() => onSelect(id)}>
      <span className="relative flex size-4 shrink-0 items-center justify-center" role="img" aria-label={look?.label ?? "Unknown"}>
        {look?.ping && <span className={cn("absolute inline-flex size-3 animate-status-ping rounded-full", look.ping)} />}
        <span className={cn("relative inline-flex size-2 rounded-full", look?.dot ?? "bg-muted-foreground/40")} />
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <SidebarRowNote>{look?.note ?? repo.split("/")[0]}</SidebarRowNote>
    </SidebarRow>
  );
}

// Adds a project: a repo as owner/repo, then Create. No commit to the repo: a
// project file is optional. Control's refusal (a repo the user's GitHub account
// cannot see) shows under it. Escape closes it (`onClose`). `compact` fits the sidebar.
export function NewProject({
  workspace,
  compact = false,
  onCreated,
  onClose,
}: {
  workspace: Workspace;
  compact?: boolean;
  onCreated: (project: Project) => void;
  onClose?: () => void;
}) {
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = CreateProjectRequest.safeParse({ repo: repo.trim() }).success;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(Project.parse(await window.chiefbot.projects.create(workspace.id, repo.trim())));
      setRepo("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={cn("flex flex-col gap-1.5", compact ? "px-0.5 py-1" : "w-full max-w-sm")} onSubmit={(event) => void submit(event)}>
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          aria-label="Repo"
          placeholder="owner/repo"
          value={repo}
          disabled={busy}
          className="min-w-0 flex-1"
          onChange={(event) => setRepo(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && onClose?.()}
        />
        <Button type="submit" size={compact ? "xs" : "sm"} disabled={busy || !valid}>
          Create
        </Button>
      </div>
      {busy && (
        <p className="flex items-center gap-1.5 px-1 text-muted-foreground text-xs">
          <Spinner className="size-3 shrink-0" />
          Reading the repo and starting the project…
        </p>
      )}
      {!busy && repo !== "" && !valid && <p className="px-1 text-muted-foreground text-xs">Write it as owner/repo.</p>}
      <ErrorText message={error} />
    </form>
  );
}
