import { z } from "zod";
import { ApprovalKind, SetupStep } from "./chat.ts";
import { ConnectorName } from "./connectors.ts";
import { ApprovalId, ProjectId, TaskWorkerId } from "./ids.ts";
import { ProjectMcpServer, RepoPath, SecretName } from "./projects.ts";
import { RepoFullName } from "./repos.ts";
import { CopilotPayer } from "./workspaces.ts";

// A worker's life. The UI and the agents' prompts call a task worker an engineer.
//   queued      the project already runs as many as its workers.max: it launches once one of them ends
//   launching   control wrote its launch record and is making its computer, or the worker has not connected yet
//   setting_up  its computer sets up (EngineerSetup) before its agent starts; `setup` lists each step that ran
//   working     its agent works on the task
//   finished    the task's turn ended; `result` is the worker's last message: what its pull
//               request does, or its report when it opened none
//   blocked     its setup failed, so its agent never started; `result` says why, `setup` has the log
//   failed      the turn ended with an error, or the computer could not start; `result` says why
//   stopped     the coordinator stopped it, or the task was closed while it worked
export const TaskWorkerState = z.enum(["queued", "launching", "setting_up", "working", "finished", "blocked", "failed", "stopped"]);
export type TaskWorkerState = z.infer<typeof TaskWorkerState>;

// One worker of a project, as the coordinator and the project's members see it.
// `requestedBy` is the login of the member whose coordinator turn dispatched it:
// it runs on their Copilot seat and only they answer its approvals. Its computer
// stops when its turn ends and is deleted, disk and all, once the task is done
// or abandoned, or the worker is stopped.
// Times are epoch milliseconds.
export const TaskWorker = z.object({
  id: TaskWorkerId,
  projectId: ProjectId,
  taskNumber: z.number().int().min(1),
  requestedBy: z.string(),
  // Who pays for its Copilot: set once its task starts.
  payer: CopilotPayer.nullable(),
  state: TaskWorkerState,
  // Each step of its setup that ran, in order.
  setup: z.array(SetupStep),
  result: z.string().nullable(),
  pullRequest: z.url().nullable(),
  // What it waits on the requester to approve: a push, a pull request or a GitHub tool.
  pendingApprovals: z.array(z.object({ approvalId: ApprovalId, kind: ApprovalKind, detail: z.string() })),
  computerRemoved: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TaskWorker = z.infer<typeof TaskWorker>;

// What an engineer's computer sets up before its agent starts (a run-task's
// `setup`), from the project's config when its task starts. It clones `repo`
// from its default branch through control's git proxy, runs `command`
// (commands.setup) in the clone, and gives its agent's session the repo's
// instructions (AGENTS.md, .github/copilot-instructions.md and `instructions`),
// its `skills` folders and its `mcp` servers, working in the clone. `secrets` are
// the values of the project's secrets that are set, by name: they are in the
// environment of the setup command and of the agent's runtime, for this task only.
export const EngineerSetup = z.object({
  repo: RepoFullName,
  command: z.string().nullable(),
  instructions: z.array(RepoPath),
  skills: z.array(RepoPath),
  mcp: z.record(ConnectorName, ProjectMcpServer),
  secrets: z.record(SecretName, z.string()),
});
export type EngineerSetup = z.infer<typeof EngineerSetup>;

// Every worker of a project: what /events sends on every change (a `workers`
// ClientEvent), and what Electron main hands the renderer.
export const ProjectWorkers = z.object({ projectId: ProjectId, workers: z.array(TaskWorker) });
export type ProjectWorkers = z.infer<typeof ProjectWorkers>;

// The answer of the coordinator's worker_transcript tool: what the worker did, one line per
// setup step, message, tool call, approval or error, oldest first. `truncated` when older lines were left out.
export const WorkerTranscript = z.object({ worker: TaskWorkerId, lines: z.array(z.string()), truncated: z.boolean() });
export type WorkerTranscript = z.infer<typeof WorkerTranscript>;
