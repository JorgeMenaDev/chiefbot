import {
  currentVerification,
  type ContextPath,
  type CopilotPayer,
  type Project,
  type Task,
  type TaskStatus,
  type TaskWorker,
  type TaskWorkerId,
  type TaskWorkerState,
  type VerdictLine,
  type VerdictResult,
} from "@chiefbot/contracts";
import { CheckIcon, MonitorIcon } from "lucide-react";
import { useState } from "react";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { EngineerDetails } from "./EngineerDetails.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";

// The Tasks tab of a project's panel: its task ledger, each task with its
// engineers and verifiers, what they wait on, their pull requests and the
// verifier's verdict. `onWatch` opens a worker in the Engineers tab, and
// `onEvidence` a verdict's report in the Context tab. Any member may mark an
// open task with a pull request done, which the done rule does not stop for
// them: the task shows each time one did.
export function TaskLedger({
  project,
  login,
  tasks,
  workers,
  onWatch,
  onEvidence,
}: {
  project: Project;
  login: string;
  tasks: Task[];
  workers: TaskWorker[];
  onWatch: (workerId: TaskWorkerId) => void;
  onEvidence: (path: ContextPath) => void;
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
            <TaskVerification task={task} onEvidence={onEvidence} />
            {task.overrides.map(({ by, at, verification }) => (
              <span key={at} className="text-muted-foreground text-xs" title={new Date(at).toLocaleString()}>
                Marked done in the app by {by} · {verification ? verdictText(verification) : "not verified"}
              </span>
            ))}
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

// The task's verdict on its latest pull request, with its report; nothing before one.
function TaskVerification({ task, onEvidence }: { task: Task; onEvidence: (path: ContextPath) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verification = currentVerification(task);
  const closed = task.status === "done" || task.status === "abandoned";
  const markable = !closed && task.links.some(({ kind }) => kind === "pull-request");
  if (!verification && !markable) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {verification && (
        <>
          <span className={verdictColor(verification)}>
            {verdictText(verification)}
            {verification.result !== "pass" && `: ${verification.summary}`}
          </span>
          <button type="button" className="cursor-pointer text-primary underline-offset-4 hover:underline" onClick={() => onEvidence(verification.evidence)}>
            Report
          </button>
        </>
      )}
      {markable && (
        <Button
          size="xs"
          variant="outline"
          className="ms-auto"
          disabled={busy}
          title="Mark it done without a verifier's PASS for its head. The task records that you did."
          onClick={() => {
            setBusy(true);
            setError(null);
            window.chiefbot.projects
              .markDone(task.projectId, task.number)
              .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
              .finally(() => setBusy(false));
          }}
        >
          <CheckIcon />
          Mark done
        </Button>
      )}
      {error && <span className="w-full text-destructive-foreground">{error}</span>}
    </span>
  );
}

const verdictLabel: Record<VerdictResult, string> = { pass: "Verified PASS", issues: "ISSUES", blocked: "BLOCKED" };

// A verdict in a line: "Verified PASS @abc1234", "ISSUES @abc1234" or
// "BLOCKED @abc1234", then "· stale" once the pull request has moved since.
export const verdictText = ({ result, sha, stale }: VerdictLine) => `${verdictLabel[result]} @${sha.slice(0, 7)}${stale ? " · stale" : ""}`;

// A verdict's colour: success for a PASS at the head, a warning for one gone stale or a check that was blocked.
export const verdictColor = ({ result, stale }: VerdictLine) =>
  cn(result === "issues" ? "text-destructive-foreground" : result === "blocked" || stale ? "text-warning-foreground" : "text-success-foreground");

// Who pays for a run, in a line.
export function payerText(payer: CopilotPayer) {
  return payer.kind === "seat" ? `On ${payer.login}'s Copilot seat` : `Billed to ${payer.account}'s Copilot (organization)`;
}

// One engineer or verifier of a task: its state, who pays for it, its pull request, its setup and
// how it ended (EngineerDetails), and what it waits on. Only the member who asked for it answers its
// approvals; the others see who must.
function WorkerRow({ project, worker, login, onWatch }: { project: Project; worker: TaskWorker; login: string; onWatch: () => void }) {
  return (
    <div className="flex flex-col gap-2 border-l-2 ps-3">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-muted-foreground text-xs">
          {worker.kind === "verifier" ? "Verifier" : "Engineer"}: {workerStateText[worker.state]}
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
