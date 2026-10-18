import { z } from "zod";
import { ChatItem, TurnEventMessage, TurnHello, TurnKeyMessage } from "./chat.ts";
import { AgentConnector } from "./connectors.ts";
import { ProjectId, TaskWorkerId, TurnId, TurnKey, UserId, WorkspaceId } from "./ids.ts";
import { RepoFullName } from "./repos.ts";
import { CopilotPayer } from "./workspaces.ts";

// The repo's chiefbot.project.yaml, at its root on the default branch. Control
// reads it when the project is created. Unknown keys are errors, so a typo is
// caught instead of ignored.
//   connectors  the connectors (MCP servers) the project's agents need, by name
//   commands    how to build and test the repo, which the coordinator and its workers are told
export const ProjectFile = z.strictObject({
  connectors: z.array(z.string().trim().min(1)).default([]),
  commands: z.strictObject({ build: z.string().trim().min(1).optional(), test: z.string().trim().min(1).optional() }).default({}),
});
export type ProjectFile = z.infer<typeof ProjectFile>;

// The file name control reads at the repo's root.
export const projectFileName = "chiefbot.project.yaml";

// A project as a member of its workspace sees it. `name` is the repo's name.
export const Project = z.object({ id: ProjectId, workspaceId: WorkspaceId, name: z.string(), repo: RepoFullName, file: ProjectFile });
export type Project = z.infer<typeof Project>;

// Body of POST /workspaces/:id/projects.
export const CreateProjectRequest = z.object({ repo: RepoFullName });
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

// A shared context file's path inside the project's context: Markdown only,
// folders allowed, no segment starting with a dot (so no "..").
// Conventions: notes.md (status), docs/ (lasting context), plans/, internal/.
export const ContextPath = z
  .string()
  .max(200)
  .regex(/^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.md$/, "expected a relative Markdown path like docs/notes.md")
  .brand<"ContextPath">();
export type ContextPath = z.infer<typeof ContextPath>;

// One shared context file. updatedAt is epoch milliseconds.
export const ContextFile = z.object({ path: ContextPath, size: z.number().int(), updatedAt: z.number() });
export type ContextFile = z.infer<typeof ContextFile>;

// open         nobody works on it yet
// in_progress  someone (a person or a worker) works on it
// needs_input  it waits for a person's answer or decision
// done         finished
// abandoned    dropped
export const TaskStatus = z.enum(["open", "in_progress", "needs_input", "done", "abandoned"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

// What a task points at: a pull request, a shared context file or any web page.
export const TaskLink = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pull-request"), url: z.url() }),
  z.object({ kind: z.literal("context"), path: ContextPath }),
  z.object({ kind: z.literal("url"), url: z.url() }),
]);
export type TaskLink = z.infer<typeof TaskLink>;

// One task of a project's ledger in control: the only record of its state.
// `number` counts from 1 per project. `owner` is the GitHub login of the member
// who owns it, or null. `requestedBy` is the login of the member whose chat
// created it. Times are epoch milliseconds.
export const Task = z.object({
  projectId: ProjectId,
  number: z.number().int().min(1),
  title: z.string(),
  detail: z.string(),
  status: TaskStatus,
  owner: z.string().nullable(),
  requestedBy: z.string(),
  links: z.array(TaskLink),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof Task>;

// A project's whole task ledger: what /events sends on every change (a `tasks`
// ClientEvent), and what Electron main hands the renderer.
export const ProjectTasks = z.object({ projectId: ProjectId, tasks: z.array(Task) });
export type ProjectTasks = z.infer<typeof ProjectTasks>;

// The coordinator's tools, by name. Each argument schema is also what the model sees.
export const CreateTaskArgs = z.object({
  title: z.string().trim().min(1).max(200).describe("A short, specific title"),
  detail: z.string().max(20_000).default("").describe("What done looks like, and anything the worker needs to know"),
  owner: z.string().nullable().default(null).describe("GitHub login of the member who owns it, or null"),
});
export const UpdateTaskArgs = z.object({
  number: z.number().int().min(1).describe("The task's number"),
  title: z.string().trim().min(1).max(200).optional(),
  detail: z.string().max(20_000).optional(),
  status: TaskStatus.optional(),
  owner: z.string().nullable().optional().describe("GitHub login of the member who owns it, or null"),
  links: z.array(TaskLink).optional().describe("Links to add to the task"),
});
export const ListTasksArgs = z.object({
  status: z.array(TaskStatus).optional().describe("Only tasks with these statuses; all tasks when left out"),
});
export const ReadContextArgs = z.object({
  path: ContextPath.optional().describe("The file to read; left out, the list of files"),
});
export const WriteContextArgs = z.object({
  path: ContextPath.describe("The file to write, e.g. notes.md or plans/checkout.md"),
  content: z.string().max(200_000).describe("The file's whole new content, in Markdown"),
});

export const DispatchWorkerArgs = z.object({
  task: z.number().int().min(1).describe("The number of the task the worker does"),
  instructions: z.string().max(20_000).default("").describe("Anything the worker needs beyond the task's title and detail"),
});
export const WorkerStatusArgs = z.object({
  worker: TaskWorkerId.optional().describe("The worker's id; left out, every worker of the project"),
});
export const WorkerTranscriptArgs = z.object({
  worker: TaskWorkerId.describe("The worker's id"),
  lines: z.number().int().min(1).max(500).default(100).describe("At most this many of its latest lines"),
});
export const StopWorkerArgs = z.object({ worker: TaskWorkerId.describe("The worker's id") });

// Body of POST /coordinator/:projectId/tools: one tool call of the running coordinator turn.
// Its answer, as JSON: create_task and update_task → Task; list_tasks → Task[];
// read_context → ContextFile[] without a path, { path, content } with one; write_context → ContextFile;
// dispatch_worker, stop_worker and worker_status with a worker → TaskWorker; worker_status
// without one → TaskWorker[]; worker_transcript → WorkerTranscript (taskWorkers.ts).
// dispatch_worker's `creationId` is not the model's: the coordinator sets it from the
// tool call's id, so a resent call starts no second worker.
export const CoordinatorToolCall = z.discriminatedUnion("tool", [
  CreateTaskArgs.extend({ tool: z.literal("create_task") }),
  UpdateTaskArgs.extend({ tool: z.literal("update_task") }),
  ListTasksArgs.extend({ tool: z.literal("list_tasks") }),
  ReadContextArgs.extend({ tool: z.literal("read_context") }),
  WriteContextArgs.extend({ tool: z.literal("write_context") }),
  DispatchWorkerArgs.extend({ tool: z.literal("dispatch_worker"), creationId: z.string().min(1).max(300) }),
  WorkerStatusArgs.extend({ tool: z.literal("worker_status") }),
  WorkerTranscriptArgs.extend({ tool: z.literal("worker_transcript") }),
  StopWorkerArgs.extend({ tool: z.literal("stop_worker") }),
]);
export type CoordinatorToolCall = z.infer<typeof CoordinatorToolCall>;

// The member a coordinator turn runs for: whose chat it is and whose Copilot seat it uses.
export const ProjectMember = z.object({ userId: UserId, login: z.string() });
export type ProjectMember = z.infer<typeof ProjectMember>;

// Control → coordinator on the /coordinator/:projectId WebSocket.
//   bound     the project this connection belongs to; sent right after control accepts the credential
//   run-turn  run one turn in `member`'s chat, on `payer`'s Copilot: the member's
//             seat (GET …/github-token) or the organization's
//             (GET …/installation-token). `turnKey` is the turn's key (ids.ts
//             TurnKey): the bearer of every call to control in the turn, which
//             acts only as `member` and only in this turn. Control's scheduler sends one at a time
//             per project, across all members' chats. `connectors` are the MCP
//             servers the member's session gets: those the project file declares
//             that are defined in the workspace and ready for this member. They
//             act as the member (or the workspace, for a shared connector)
//             whoever pays for Copilot.
//   turn-key  the running turn's new key (chat.ts TurnKeyMessage)
//   member-removed  the member left the workspace or was removed: control ended
//             their turn and revoked its key. Their session stops now and closes
//             (an organization's runtime with it); nothing it does reaches a chat.
export const ControlToCoordinator = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bound"), project: Project }),
  z.object({
    type: z.literal("run-turn"),
    turnId: TurnId,
    turnKey: TurnKey,
    member: ProjectMember,
    text: z.string(),
    payer: CopilotPayer,
    connectors: z.array(AgentConnector).default([]),
  }),
  TurnKeyMessage,
  z.object({ type: z.literal("member-removed"), userId: UserId }),
]);
export type ControlToCoordinator = z.infer<typeof ControlToCoordinator>;

// Coordinator → control on the same WebSocket: turn-event and hello, as a bot's worker sends them (chat.ts).
export const CoordinatorToControl = z.discriminatedUnion("type", [TurnEventMessage, TurnHello]);
export type CoordinatorToControl = z.infer<typeof CoordinatorToControl>;

// A member's chat with the project's coordinator as the desktop window shows it.
export const ProjectChatView = z.object({ projectId: ProjectId, items: z.array(ChatItem), working: z.string().nullable() });
export type ProjectChatView = z.infer<typeof ProjectChatView>;
