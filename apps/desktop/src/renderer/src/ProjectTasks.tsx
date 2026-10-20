import type { CopilotPayer, Project, Task, TaskStatus, TaskWorker, TaskWorkerId, TaskWorkerState } from "@chiefbot/contracts";
import { MonitorIcon } from "lucide-react";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { EngineerDetails } from "./EngineerDetails.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";

// The Tasks tab of a project's panel: its task ledger, each task with its
// engineers, what they wait on and their pull requests. `onWatch` opens an
// engineer in the Engineers tab.
export function TaskLedger({
  project,
  login,
  tasks,
  workers,
  onWatch,
}: {
  project: Project;
  login: string;
  tasks: Task[];
  workers: TaskWorker[];
  onWatch: (workerId: TaskWorkerId) => void;
}) {
  return (
    <div className="flex flex-col gap-2 p-3">
      {tasks.length === 0 && <p className="py-6 text-center text-muted-foreground text-xs">No tasks yet. {project.name} adds them as members ask for work.</p>}
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
            {task.question && <span className="text-warning-foreground text-xs">Asks: {task.question}</span>}
          </div>
          {workers
            .filter(({ taskNumber }) => taskNumber === task.number)
            .map((worker) => (
              <WorkerRow key={worker.id} project={project} worker={worker} login={login} onWatch={() => onWatch(worker.id)} />
            ))}
        </div>
      ))}
    </div>
  );
}

// Who pays for a run, in a line.
export function payerText(payer: CopilotPayer) {
  return payer.kind === "seat" ? `On ${payer.login}'s Copilot seat` : `Billed to ${payer.account}'s Copilot (organization)`;
}

// One engineer of a task: its state, who pays for it, its pull request, its setup and how it ended
// (EngineerDetails), and what it waits on. Only the member who asked for it answers its approvals;
// the others see who must.
function WorkerRow({ project, worker, login, onWatch }: { project: Project; worker: TaskWorker; login: string; onWatch: () => void }) {
  return (
    <div className="flex flex-col gap-2 border-l-2 ps-3">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-muted-foreground text-xs">
          Engineer: {workerStateText[worker.state]}
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
        <Button size="xs" variant="ghost" className="-my-1 shrink-0" title="Its transcript, and its screen while it works" onClick={onWatch}>
          <MonitorIcon />
          Open
        </Button>
      </div>
      <EngineerDetails worker={worker} max={project.config.workers.max} />
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

export const workerStateText: Record<TaskWorkerState, string> = {
  queued: "queued",
  launching: "starting its computer",
  setting_up: "setting up",
  working: "working",
  finished: "finished",
  blocked: "blocked",
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
