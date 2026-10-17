import { z } from "zod";
import { ApprovalKind } from "./chat.ts";
import { ApprovalId, ProjectId, TaskWorkerId } from "./ids.ts";

// A worker's life:
//   launching  control wrote its launch record and is making its computer, or the worker has not connected yet
//   working    the worker runs the task
//   finished   the task's turn ended; `result` is the worker's last message
//   failed     the turn ended with an error, or the computer could not start; `result` says why
//   stopped    the coordinator stopped it, or the task was closed while it worked
export const TaskWorkerState = z.enum(["launching", "working", "finished", "failed", "stopped"]);
export type TaskWorkerState = z.infer<typeof TaskWorkerState>;

// One worker of a project, as the coordinator and the project's members see it.
// `requestedBy` is the login of the member whose coordinator turn dispatched it:
// it runs on their Copilot seat and only they answer its approvals. Its computer
// lives until the task is done or abandoned, or the worker is stopped.
// Times are epoch milliseconds.
export const TaskWorker = z.object({
  id: TaskWorkerId,
  projectId: ProjectId,
  taskNumber: z.number().int().min(1),
  requestedBy: z.string(),
  state: TaskWorkerState,
  result: z.string().nullable(),
  pullRequest: z.url().nullable(),
  // What it waits on the requester to approve: a push, a pull request or a GitHub tool.
  pendingApprovals: z.array(z.object({ approvalId: ApprovalId, kind: ApprovalKind, detail: z.string() })),
  computerRemoved: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TaskWorker = z.infer<typeof TaskWorker>;

// The answer of the coordinator's worker_transcript tool: what the worker did, one line per
// message, tool call, approval or error, oldest first. `truncated` when older lines were left out.
export const WorkerTranscript = z.object({ worker: TaskWorkerId, lines: z.array(z.string()), truncated: z.boolean() });
export type WorkerTranscript = z.infer<typeof WorkerTranscript>;
