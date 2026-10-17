import {
  CreateProjectRequest,
  Project,
  ProjectChatView,
  ProjectId,
  Task,
  TaskWorker,
  type ChatItem,
  type TaskStatus,
  type TaskWorkerState,
  type Workspace,
} from "@chiefbot/contracts";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { z } from "zod";
import { ApprovalCard } from "./ApprovalCard.tsx";

const ProjectList = z.array(Project);
const TaskList = z.array(Task);
const Ledger = z.object({ projectId: ProjectId, tasks: TaskList });
const WorkerList = z.array(TaskWorker);
const Workers = z.object({ projectId: ProjectId, workers: WorkerList });

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
export function NewProject({ workspace, onCreated }: { workspace: Workspace; onCreated: (project: Project) => void }) {
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(Project.parse(await window.chiefbot.projects.create(workspace.id, repo)));
      setRepo("");
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
        + New project
      </button>
    );
  }
  return (
    <form className="new-bot-form" onSubmit={(event) => void submit(event)}>
      <input
        autoFocus
        placeholder="owner/repo"
        value={repo}
        disabled={busy}
        onChange={(event) => setRepo(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
      />
      {busy && <p className="muted">Reading chiefbot.project.yaml and starting the coordinator…</p>}
      {!busy && repo !== "" && !CreateProjectRequest.safeParse({ repo }).success && <p className="muted">Write it as owner/repo.</p>}
      {error && <p className="error">{error}</p>}
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
  async function remove() {
    setError(null);
    try {
      if (await window.chiefbot.projects.remove(project.id, project.name)) onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }
  return (
    <div className="bot-pane">
      <header className="bot-header">
        <div>
          <h2>{project.name}</h2>
          <p className="muted">
            {project.repo}
            {commands.build && ` · build: ${commands.build}`}
            {commands.test && ` · test: ${commands.test}`}
          </p>
          {error && <p className="error">{error}</p>}
        </div>
        {workspace.role === "owner" && (
          <div className="actions">
            <button className="danger" onClick={() => void remove()}>
              Delete
            </button>
          </div>
        )}
      </header>
      <div className="bot-body">
        <CoordinatorChat project={project} />
        <TaskLedger project={project} login={login} />
      </div>
    </div>
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
  const end = useRef<HTMLDivElement>(null);
  const working = view.working !== null;
  const canSend = !working && draft.trim() !== "";

  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [view]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    setError(null);
    try {
      await window.chiefbot.projects.send(project.id, draft);
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
          {view.items.length === 0 && (
            <p className="muted empty">Ask the coordinator to plan work on {project.name}. It tracks it as tasks every member sees.</p>
          )}
          {view.items.map((item) => (
            <ChatRow key={item.id} item={item} />
          ))}
          {working && <p className="working">{view.working || "Waiting for the coordinator"}…</p>}
          <div ref={end} />
        </div>
      </div>
      <form className="composer lane" onSubmit={(event) => void submit(event)}>
        <textarea
          rows={3}
          placeholder="Message the coordinator"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-row">
          {error ? <span className="error composer-error">{error}</span> : <span />}
          <button type="submit" disabled={!canSend}>
            Send
          </button>
        </div>
      </form>
    </section>
  );
}

// The coordinator asks for no approvals, so those never show.
function ChatRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return <div className="message user">{item.text}</div>;
    case "assistant":
      return <div className="message assistant">{item.text}</div>;
    case "tool":
      return <div className={`tool-row ${item.status}`}>{item.name}</div>;
    case "error":
      return <div className="message error">{item.message}</div>;
    case "approval":
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
      const ledger = Ledger.parse(next);
      if (ledger.projectId === project.id) setTasks(ledger.tasks);
    });
    const unsubscribeWorkers = window.chiefbot.projects.onWorkers((next) => {
      const list = Workers.parse(next);
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
    <aside className="screen-pane ledger">
      <header className="screen-header">
        <strong>Tasks</strong>
        <span className="muted">{tasks.filter(({ status }) => status !== "done" && status !== "abandoned").length} open</span>
      </header>
      {tasks.length === 0 && <p className="muted">No tasks yet. The coordinator adds them as members ask for work.</p>}
      {tasks.map((task) => (
        <div key={task.number} className="ledger-task">
          <div className="routine-text">
            <strong>
              #{task.number} {task.title}
            </strong>
            <span className="muted">
              {statusText[task.status]}
              {task.owner && ` · owner ${task.owner}`} · asked by {task.requestedBy}
            </span>
          </div>
          {workers
            .filter(({ taskNumber }) => taskNumber === task.number)
            .map((worker) => (
              <WorkerRow key={worker.id} project={project} worker={worker} login={login} />
            ))}
        </div>
      ))}
    </aside>
  );
}

// One worker of a task: its state, its pull request and what it waits on. Only
// the member who asked for it answers its approvals; the others see who must.
function WorkerRow({ project, worker, login }: { project: Project; worker: TaskWorker; login: string }) {
  return (
    <div className="worker-row">
      <span className="muted">
        Worker: {workerStateText[worker.state]}
        {worker.pullRequest && (
          <>
            {" · "}
            <a href={worker.pullRequest} target="_blank" rel="noreferrer">
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
          <span key={approvalId} className="muted">
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

const statusText: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  needs_input: "Needs input",
  done: "Done",
  abandoned: "Abandoned",
};
