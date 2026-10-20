import { engineerRuns, WorkerChatView, type Project, type Task, type TaskWorker, type TaskWorkerId, type TaskWorkerState } from "@chiefbot/contracts";
import { ChevronLeftIcon, ChevronRightIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { AssistantMessage, ChatTimeline, ErrorMessage, UserMessage } from "./Chat.tsx";
import type { LaneItem } from "./chatRows.ts";
import { LiveScreen } from "./LiveScreen.tsx";
import { engineerScreen } from "./screenTargets.tsx";
import { payerText, workerStateText } from "./ProjectTasks.tsx";
import { Button } from "./components/ui/button.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { cn } from "./lib/utils.ts";

// The Engineers tab of a project's panel: the engineers its project agent
// started, newest first. Opening one (`selected`) shows its live screen while it
// works and its transcript; `onSelect(null)` goes back to the list.
export function Engineers({
  project,
  login,
  tasks,
  workers,
  selected,
  onSelect,
}: {
  project: Project;
  login: string;
  tasks: Task[];
  workers: TaskWorker[];
  selected: TaskWorkerId | null;
  onSelect: (workerId: TaskWorkerId | null) => void;
}) {
  const titleOf = (worker: TaskWorker) => tasks.find(({ number }) => number === worker.taskNumber)?.title ?? "";
  const open = workers.find(({ id }) => id === selected);
  if (open) return <EngineerDetail key={open.id} project={project} login={login} title={titleOf(open)} worker={open} onBack={() => onSelect(null)} />;
  if (workers.length === 0) {
    return <p className="px-5 py-6 text-center text-muted-foreground text-xs">No engineers yet. {project.name} starts one when a task is ready to build.</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5 p-2">
      {workers.toSorted((a, b) => b.createdAt - a.createdAt).map((worker) => (
        <li key={worker.id}>
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm transition-colors hover:bg-accent"
            onClick={() => onSelect(worker.id)}
          >
            <StateDot state={worker.state} />
            <span className="min-w-0 flex-1 truncate">
              <span className="text-muted-foreground">#{worker.taskNumber}</span> {titleOf(worker)}
            </span>
            <span className={cn("shrink-0 text-xs", worker.pendingApprovals.length > 0 ? "text-warning-foreground" : "text-muted-foreground")}>
              {worker.pendingApprovals.length > 0 ? "waits on approval" : workerStateText[worker.state]}
            </span>
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  );
}

const stateDot: Record<TaskWorkerState, { dot: string; ping?: string }> = {
  queued: { dot: "bg-muted-foreground" },
  launching: { dot: "bg-warning", ping: "bg-warning/60" },
  setting_up: { dot: "bg-warning", ping: "bg-warning/60" },
  working: { dot: "bg-success", ping: "bg-success/60" },
  finished: { dot: "bg-success" },
  blocked: { dot: "bg-warning" },
  failed: { dot: "bg-destructive" },
  stopped: { dot: "bg-muted-foreground/40" },
};

// What an engineer does before its agent works, in its screen's place and as its transcript's status.
const startingText: Partial<Record<TaskWorkerState, string>> = { launching: "Starting its computer", setting_up: "Setting up" };

// An engineer's state as a dot, pinging while its computer starts, it sets up or it works.
function StateDot({ state }: { state: TaskWorkerState }) {
  const { dot, ping } = stateDot[state];
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center" role="img" aria-label={workerStateText[state]}>
      {ping && <span className={cn("absolute inline-flex size-3 animate-status-ping rounded-full", ping)} />}
      <span className={cn("relative inline-flex size-2 rounded-full", dot)} />
    </span>
  );
}

// One engineer: back to the list, its task, its screen and its transcript under it.
function EngineerDetail({ project, login, title, worker, onBack }: { project: Project; login: string; title: string; worker: TaskWorker; onBack: () => void }) {
  const view = useWorkerChat(project, worker.id);
  const running = engineerRuns(worker.state);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <Button size="icon-xs" variant="ghost" aria-label="Back to engineers" title="Back to engineers" onClick={onBack}>
          <ChevronLeftIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          <span className="text-muted-foreground">#{worker.taskNumber}</span> {title}
        </span>
        <StateDot state={worker.state} />
        <span className="shrink-0 text-muted-foreground text-xs">{workerStateText[worker.state]}</span>
      </div>
      <div className="flex shrink-0 flex-col gap-3 border-b px-4 py-3">
        <EngineerScreen project={project} login={login} worker={worker} />
      </div>
      <ChatTimeline
        chatKey={worker.id}
        items={view.items}
        status={running ? (view.working ?? startingText[worker.state] ?? "Working") : null}
        empty="Its transcript shows here once it starts."
        renderItem={(item, streaming) => <TranscriptRow project={project} login={login} worker={worker} item={item} streaming={streaming} />}
      />
    </div>
  );
}

// The engineer's transcript, as Electron main folds it: main follows one at a time.
function useWorkerChat(project: Project, workerId: TaskWorkerId) {
  const [view, setView] = useState<WorkerChatView>({ workerId, items: [], working: null });
  useEffect(() => {
    const unsubscribe = window.chiefbot.projects.onWorkerChat((next) => {
      const parsed = WorkerChatView.parse(next);
      if (parsed.workerId === workerId) setView(parsed);
    });
    void window.chiefbot.projects.openWorkerChat(project.id, workerId).then((next) => setView(WorkerChatView.parse(next)));
    return () => {
      unsubscribe();
      void window.chiefbot.projects.closeWorkerChat(workerId);
    };
  }, [project.id, workerId]);
  return view;
}

// The engineer's screen through control while its worker runs: watch, or take
// control (any member of the project, one at a time). Before and after, a line in its place.
function EngineerScreen({ project, login, worker }: { project: Project; login: string; worker: TaskWorker }) {
  const [failures, setFailures] = useState(0);
  if (worker.state === "queued") return <ScreenNote>Queued: it starts when one of the project's engineers ends.</ScreenNote>;
  const starting = startingText[worker.state];
  if (starting) return <ScreenNote><Spinner className="size-3.5" />{starting}…</ScreenNote>;
  if (worker.state !== "working") return <ScreenNote>Its computer is gone. Its screen shows only while it works.</ScreenNote>;
  if (failures >= 3) {
    return (
      <ScreenNote>
        Can't reach its screen.
        <Button size="xs" variant="outline" onClick={() => setFailures(0)}>
          <RotateCwIcon />
          Try again
        </Button>
      </ScreenNote>
    );
  }
  return <LiveScreen target={engineerScreen(project.id, worker, login)} setFailures={setFailures} />;
}

function ScreenNote({ children }: { children: ReactNode }) {
  return <p className="flex items-center justify-center gap-2 py-2 text-center text-muted-foreground text-xs">{children}</p>;
}

// What the engineer did, as the bot chat draws it. Only the member who asked for
// the work answers its approvals; the others see who must.
function TranscriptRow({ project, login, worker, item, streaming }: { project: Project; login: string; worker: TaskWorker; item: LaneItem; streaming: boolean }) {
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.text} />;
    case "assistant":
      return <AssistantMessage text={item.text} streaming={streaming} />;
    case "error":
      return <ErrorMessage message={item.message} />;
    case "payer":
      return <p className="text-muted-foreground text-xs">{payerText(item.payer)}</p>;
    case "approval":
      return item.state !== "pending" || worker.requestedBy === login ? (
        <ApprovalCard item={item} onAnswer={(approved) => window.chiefbot.projects.answer(project.id, worker.id, item.approvalId, approved)} />
      ) : (
        <p className="text-muted-foreground text-xs">
          Waiting for {worker.requestedBy} to approve: {item.detail.split("\n")[0]}
        </p>
      );
    case "handoff":
    case "notice":
    case "question":
      return null;
  }
}
