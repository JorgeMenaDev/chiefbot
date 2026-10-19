import {
  CreateProjectRequest,
  Project,
  ProjectChatView,
  ProjectTasks,
  ProjectWorkers,
  Task,
  TaskWorker,
  type ChatItem,
  type CopilotPayer,
  type ProjectId,
  type TaskStatus,
  type TaskWorkerState,
  type Workspace,
} from "@chiefbot/contracts";
import { FolderGit2Icon, ListChecksIcon, PlugIcon, RadioIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { AssistantMessage, ChatEmpty, Composer, ErrorMessage, Timeline, ToolRow, UserMessage, Working } from "./Chat.tsx";
import { ConnectorCalls } from "./Connectors.tsx";
import { Column, ErrorText, PaneHeader, SidePanel } from "./Pane.tsx";
import { ListeningTo } from "./Subscriptions.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Spinner } from "./components/ui/spinner.tsx";

const ProjectList = z.array(Project);
const TaskList = z.array(Task);
const WorkerList = z.array(TaskWorker);

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

// The sidebar's new-project form: a repo as owner/name. Control reads the repo's
// chiefbot.project.yaml, and its refusal (what is wrong with the file) shows here.
// Escape or a made project closes it (`onClose`).
export function NewProject({ workspace, onCreated, onClose }: { workspace: Workspace; onCreated: (project: Project) => void; onClose: () => void }) {
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(Project.parse(await window.chiefbot.projects.create(workspace.id, repo)));
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
        placeholder="owner/repo"
        value={repo}
        disabled={busy}
        onChange={(event) => setRepo(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      />
      {busy && (
        <p className="flex items-center gap-1.5 px-1 text-muted-foreground text-xs">
          <Spinner className="size-3 shrink-0" />
          Reading chiefbot.project.yaml and starting the coordinator…
        </p>
      )}
      {!busy && repo !== "" && !CreateProjectRequest.safeParse({ repo }).success && (
        <p className="px-1 text-muted-foreground text-xs">Write it as owner/repo.</p>
      )}
      <ErrorText message={error} />
    </form>
  );
}

// A project: the user's chat with its coordinator, and the task ledger beside it.
// The workspace owner can delete it; `onDeleted` runs once it is gone. `login` is the signed-in user's.
export function ProjectPane({
  project,
  workspace,
  login,
  onDeleted,
}: {
  project: Project;
  workspace: Workspace;
  login: string;
  onDeleted: () => void;
}) {
  const { commands } = project.file;
  const [error, setError] = useState<string | null>(null);
  const [showCalls, setShowCalls] = useState(false);
  const [showListening, setShowListening] = useState(false);
  async function remove() {
    setError(null);
    try {
      if (await window.chiefbot.projects.remove(project.id, project.name)) onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }
  return (
    <>
      <Column>
        <PaneHeader
          icon={<FolderGit2Icon className="size-4 text-muted-foreground" />}
          title={project.name}
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
          {workspace.role === "owner" && (
            <Button size="xs" variant="destructive-outline" onClick={() => void remove()}>
              <Trash2Icon />
              Delete
            </Button>
          )}
        </PaneHeader>
        {error && (
          <div className="border-b px-5 py-2">
            <ErrorText message={error} />
          </div>
        )}
        {showListening && <ListeningTo project={project} />}
        {showCalls && <ConnectorCalls project={project} />}
        <CoordinatorChat project={project} />
      </Column>
      <TaskLedger project={project} login={login} />
    </>
  );
}

// The user's own chat with the coordinator, as Electron main folds it.
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
function CoordinatorChat({ project }: { project: Project }) {
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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Timeline follow={view}>
        {view.items.length === 0 && (
          <ChatEmpty>Ask the coordinator to plan work on {project.name}. It tracks it as tasks every member sees.</ChatEmpty>
        )}
        {view.items.map((item) => (
          <ChatRow key={item.id} project={project} item={item} />
        ))}
        {working && <Working>{view.working || "Waiting for the coordinator"}</Working>}
      </Timeline>
      <Composer
        placeholder="Message the coordinator"
        draft={draft}
        onDraft={setDraft}
        onSend={() => void submit()}
        canSend={canSend}
        error={error}
      />
    </section>
  );
}

// The coordinator gets no handoff notices, so those never show. Its approvals
// are control's, for connector calls that may write. Each turn starts with who
// pays for its Copilot.
function ChatRow({ project, item }: { project: Project; item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.text} />;
    case "assistant":
      return <AssistantMessage text={item.text} />;
    case "tool":
      return <ToolRow name={item.name} status={item.status} />;
    case "error":
      return <ErrorMessage message={item.message} />;
    case "payer":
      return <p className="text-muted-foreground text-xs">{payerText(item.payer)}</p>;
    case "approval":
      return <ApprovalCard item={item} onAnswer={(approved) => window.chiefbot.projects.answerChat(project.id, item.approvalId, approved)} />;
    case "notice":
      return null;
  }
}

// The project's task ledger and each task's workers: fetched once, then kept
// live by the ledgers and worker lists control sends on /events.
function TaskLedger({ project, login }: { project: Project; login: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workers, setWorkers] = useState<TaskWorker[]>([]);
  useEffect(() => {
    const unsubscribeTasks = window.chiefbot.projects.onTasks((next) => {
      const ledger = ProjectTasks.parse(next);
      if (ledger.projectId === project.id) setTasks(ledger.tasks);
    });
    const unsubscribeWorkers = window.chiefbot.projects.onWorkers((next) => {
      const list = ProjectWorkers.parse(next);
      if (list.projectId === project.id) setWorkers(list.workers);
    });
    void window.chiefbot.projects.tasks(project.id).then((next) => setTasks(TaskList.parse(next)));
    void window.chiefbot.projects.workers(project.id).then((next) => setWorkers(WorkerList.parse(next)));
    return () => {
      unsubscribeTasks();
      unsubscribeWorkers();
    };
  }, [project.id]);

  return (
    <SidePanel
      bar={
        <>
          <ListChecksIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">Tasks</span>
          <Badge variant="secondary" className="ms-auto">
            {tasks.filter(({ status }) => status !== "done" && status !== "abandoned").length} open
          </Badge>
        </>
      }
    >
      <div className="flex flex-col gap-2 p-3">
        {tasks.length === 0 && <p className="py-6 text-center text-muted-foreground text-xs">No tasks yet. The coordinator adds them as members ask for work.</p>}
        {tasks.map((task) => (
          <div key={task.number} className="flex flex-col gap-2 rounded-xl border bg-card p-3">
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-sm">
                <span className="text-muted-foreground">#{task.number}</span> {task.title}
              </span>
              <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
                <Badge variant={statusBadge[task.status]}>{statusText[task.status]}</Badge>
                {task.owner && `owner ${task.owner} ·`} asked by {task.requestedBy}
              </span>
            </div>
            {workers
              .filter(({ taskNumber }) => taskNumber === task.number)
              .map((worker) => (
                <WorkerRow key={worker.id} project={project} worker={worker} login={login} />
              ))}
          </div>
        ))}
      </div>
    </SidePanel>
  );
}

// Who pays for a run, in a line.
function payerText(payer: CopilotPayer) {
  return payer.kind === "seat" ? `On ${payer.login}'s Copilot seat` : `Billed to ${payer.account}'s Copilot (organization)`;
}

// One worker of a task: its state, who pays for it, its pull request and what it waits on. Only
// the member who asked for it answers its approvals; the others see who must.
function WorkerRow({ project, worker, login }: { project: Project; worker: TaskWorker; login: string }) {
  return (
    <div className="flex flex-col gap-2 border-l-2 ps-3">
      <span className="text-muted-foreground text-xs">
        Worker: {workerStateText[worker.state]}
        {worker.payer && ` · ${payerText(worker.payer)}`}
        {worker.pullRequest && (
          <>
            {" · "}
            <a className="text-primary underline-offset-4 hover:underline" href={worker.pullRequest} target="_blank" rel="noreferrer">
              pull request
            </a>
          </>
        )}
      </span>
      {worker.pendingApprovals.map(({ approvalId, kind, detail }) =>
        worker.requestedBy === login ? (
          <ApprovalCard
            key={approvalId}
            item={{ kind: "approval", id: approvalId, approvalId, request: kind, detail, state: "pending" }}
            onAnswer={(approved) => window.chiefbot.projects.answer(project.id, worker.id, approvalId, approved)}
          />
        ) : (
          <span key={approvalId} className="text-muted-foreground text-xs">
            Waiting for {worker.requestedBy} to approve: {detail.split("\n")[0]}
          </span>
        ),
      )}
    </div>
  );
}

const workerStateText: Record<TaskWorkerState, string> = {
  launching: "starting its computer",
  working: "working",
  finished: "finished",
  failed: "failed",
  stopped: "stopped",
};

const statusBadge: Record<TaskStatus, "outline" | "info" | "warning" | "success" | "secondary"> = {
  open: "outline",
  in_progress: "info",
  needs_input: "warning",
  done: "success",
  abandoned: "secondary",
};

const statusText: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  needs_input: "Needs input",
  done: "Done",
  abandoned: "Abandoned",
};
