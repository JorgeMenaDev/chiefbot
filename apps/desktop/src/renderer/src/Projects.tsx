import { type AutoFallback, type CopilotPayer, Project, ProjectChatView, type ProjectId, type Workspace } from "@chiefbot/contracts";
import { FolderGit2Icon, PlugIcon, RadioIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { AssistantMessage, ChatTimeline, ErrorMessage, UserMessage } from "./Chat.tsx";
import type { LaneItem } from "./chatRows.ts";
import { Composer } from "./Composer.tsx";
import { ConnectorCalls } from "./Connectors.tsx";
import { Column, ErrorText, PaneHeader, PanelToggle, Section } from "./Pane.tsx";
import { ProjectComposerControls } from "./ProjectComposerControls.tsx";
import { ProjectPanel } from "./ProjectPanel.tsx";
import { fileNote, ProjectSettings } from "./ProjectSettings.tsx";
import { payerText } from "./ProjectTasks.tsx";
import { ListeningTo } from "./Subscriptions.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";

const ProjectList = z.array(Project);

// The current workspace's projects. Control sends no project events, so `reload`
// runs when the workspace changes and after a project is made.
export function useProjects(workspace: Workspace | null) {
  const [projects, setProjects] = useState<Project[]>([]);
  const reload = async () => {
    setProjects(workspace ? ProjectList.parse(await window.chiefbot.projects.list(workspace.id)) : []);
  };
  useEffect(() => {
    void reload();
  }, [workspace?.id]);
  return { projects, reload };
}

const panelKey = "chiefbot.projectPanel";

// A project: the user's conversation with its project agent, and the work panel
// beside it (ProjectPanel.tsx). The gear opens its settings in the conversation's
// place, where the workspace owner can also delete it; `onDeleted` runs once it
// is gone, and `onChanged` once its settings or model are saved. `login` is the signed-in user's.
export function ProjectPane({
  project,
  workspace,
  login,
  onDeleted,
  onChanged,
}: {
  project: Project;
  workspace: Workspace;
  login: string;
  onDeleted: () => void;
  onChanged: () => void;
}) {
  const { commands } = project.config;
  const [showCalls, setShowCalls] = useState(false);
  const [showListening, setShowListening] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [panel, setPanel] = useState(() => localStorage.getItem(panelKey) !== "closed");
  const showPanel = (open: boolean) => {
    setPanel(open);
    localStorage.setItem(panelKey, open ? "open" : "closed");
  };
  return (
    <>
      <Column>
        <PaneHeader
          icon={<FolderGit2Icon className="size-4 text-muted-foreground" />}
          title={
            <span className="flex items-center gap-2">
              {project.name}
              {project.file.status !== "found" && (
                <Badge variant={project.file.status === "invalid" ? "warning" : "outline"} title={fileNote(project)}>
                  {project.file.status === "invalid" ? "Invalid project file" : "No project file"}
                </Badge>
              )}
            </span>
          }
          note={`${project.repo}${commands.build ? ` · build: ${commands.build}` : ""}${commands.test ? ` · test: ${commands.test}` : ""}`}
        >
          <Button size="xs" variant="outline" pressed={showListening} onClick={() => setShowListening(!showListening)}>
            <RadioIcon />
            Listening to
          </Button>
          <Button size="xs" variant="outline" pressed={showCalls} onClick={() => setShowCalls(!showCalls)}>
            <PlugIcon />
            Connector calls
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            pressed={showSettings}
            aria-label="Project settings"
            title={showSettings ? "Back to the conversation" : "Settings"}
            onClick={() => setShowSettings(!showSettings)}
          >
            <SettingsIcon />
          </Button>
          {!panel && <PanelToggle open={false} label="Project panel" onClick={() => showPanel(true)} />}
        </PaneHeader>
        {showListening && <ListeningTo project={project} />}
        {showCalls && <ConnectorCalls project={project} />}
        {showSettings && (
          <ProjectSettings project={project} onSaved={onChanged}>
            {workspace.role === "owner" && <DeleteProject project={project} onDeleted={onDeleted} />}
          </ProjectSettings>
        )}
        <CoordinatorChat project={project} hidden={showSettings} onChanged={onChanged} />
      </Column>
      <ProjectPanel project={project} login={login} hidden={!panel} onClose={() => showPanel(false)} />
    </>
  );
}

// The owner's Delete, at the end of the settings. Electron main asks to confirm first.
function DeleteProject({ project, onDeleted }: { project: Project; onDeleted: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    setError(null);
    try {
      if (await window.chiefbot.projects.remove(project.id, project.name)) onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }
  return (
    <Section title="Delete project" description={`Deletes ${project.name}'s computers, tasks, settings and secret values. The repo stays as it is.`}>
      <div className="flex items-center justify-between gap-3 pb-2">
        <ErrorText message={error} />
        <Button size="xs" variant="destructive-outline" className="ms-auto" onClick={() => void remove()}>
          <Trash2Icon />
          Delete
        </Button>
      </div>
    </Section>
  );
}

// The user's own conversation with the project agent, as Electron main folds it.
function useCoordinatorChat(projectId: ProjectId) {
  const [view, setView] = useState<ProjectChatView>({ projectId, items: [], working: null });
  useEffect(() => {
    const unsubscribe = window.chiefbot.projects.onChat((next) => {
      const parsed = ProjectChatView.parse(next);
      if (parsed.projectId === projectId) setView(parsed);
    });
    void window.chiefbot.projects.openChat(projectId).then((next) => setView(ProjectChatView.parse(next)));
    return unsubscribe;
  }, [projectId]);
  return view;
}

// The bot chat's shape (Chat.tsx). Every member has their own chat; the
// coordinator answers one member at a time, so a message may wait its turn.
// `hidden` keeps the draft while the settings view takes its place. The
// composer picks the project's model; `onChanged` runs once one is saved.
function CoordinatorChat({ project, hidden, onChanged }: { project: Project; hidden: boolean; onChanged: () => void }) {
  const view = useCoordinatorChat(project.id);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const working = view.working !== null;
  const canSend = !working && draft.trim() !== "";

  async function submit() {
    if (!canSend) return;
    setError(null);
    try {
      await window.chiefbot.projects.send(project.id, draft);
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section hidden={hidden} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ChatTimeline
        chatKey={project.id}
        items={view.items}
        status={working ? view.working || `Waiting for ${project.name}` : null}
        empty={`Ask ${project.name} to plan work. It tracks it as tasks every member sees, and starts engineers to build them.`}
        renderItem={(item, streaming) => <ChatRow project={project} item={item} streaming={streaming} />}
      />
      <Composer
        placeholder={`Message ${project.name}`}
        draft={draft}
        onDraft={setDraft}
        onSend={() => void submit()}
        canSend={canSend}
        error={error}
      >
        <ProjectComposerControls project={project} onSaved={onChanged} onError={setError} />
      </Composer>
    </section>
  );
}

// The coordinator gets no handoff cards or notices, so those never show. Its approvals
// are control's, for connector calls that may write. Each turn starts with who
// pays for its Copilot.
function ChatRow({ project, item, streaming }: { project: Project; item: LaneItem; streaming: boolean }) {
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.text} />;
    case "assistant":
      return <AssistantMessage text={item.text} streaming={streaming} />;
    case "error":
      return <ErrorMessage message={item.message} />;
    case "payer":
      return (
        <p className="text-muted-foreground text-xs">
          {payerText(item.payer)}
          {item.fallback && <span className="block">{fellBack(item.payer, item.fallback)}</span>}
        </p>
      );
    case "approval":
      return <ApprovalCard item={item} onAnswer={(approved) => window.chiefbot.projects.answerChat(project.id, item.approvalId, approved)} />;
    case "handoff":
    case "notice":
    // Only bots ask their user questions for now.
    case "question":
      return null;
  }
}

// Why a turn ran on Auto: the plan of who paid does not offer the project's
// model, or no turn on it has listed its models yet.
function fellBack(payer: CopilotPayer, { model, reason }: AutoFallback) {
  const who = payer.kind === "seat" ? payer.login : payer.account;
  return reason === "plan_unknown" ? `${who}'s plan isn't known yet; this turn ran on Auto.` : `${model} isn't on ${who}'s plan; this turn ran on Auto.`;
}
