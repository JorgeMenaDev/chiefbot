import { z } from "zod";
import { ChatItem, TurnEventMessage, TurnHello } from "./chat.ts";
import { ProjectId, TurnId, UserId, WorkspaceId } from "./ids.ts";
import { RepoFullName } from "./repos.ts";

// The repo's chiefbot.project.yaml, at its root on the default branch. Control
// reads it when the project is created. Unknown keys are errors, so a typo is
// caught instead of ignored.
//   connectors    the connectors (MCP servers) the project's agents need, by name
//   environments  where the project's workers run; `image` is a computer image
//                 (default: the standard bot computer)
//   commands      how to build and test the repo
export const ProjectFile = z.strictObject({
  connectors: z.array(z.string().trim().min(1)).default([]),
  environments: z.array(z.strictObject({ name: z.string().trim().min(1), image: z.string().trim().min(1).optional() })).default([]),
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

// Body of POST /coordinator/:projectId/tools: one tool call of the running coordinator turn.
// Its answer, as JSON: create_task and update_task → Task; list_tasks → Task[];
// read_context → ContextFile[] without a path, { path, content } with one; write_context → ContextFile.
export const CoordinatorToolCall = z.discriminatedUnion("tool", [
  CreateTaskArgs.extend({ tool: z.literal("create_task") }),
  UpdateTaskArgs.extend({ tool: z.literal("update_task") }),
  ListTasksArgs.extend({ tool: z.literal("list_tasks") }),
  ReadContextArgs.extend({ tool: z.literal("read_context") }),
  WriteContextArgs.extend({ tool: z.literal("write_context") }),
]);
export type CoordinatorToolCall = z.infer<typeof CoordinatorToolCall>;

// The member a coordinator turn runs for: whose chat it is and whose Copilot seat it uses.
export const ProjectMember = z.object({ userId: UserId, login: z.string() });
export type ProjectMember = z.infer<typeof ProjectMember>;

// Control → coordinator on the /coordinator/:projectId WebSocket.
//   bound     the project this connection belongs to; sent right after control accepts the credential
//   run-turn  run one turn in `member`'s chat. Control's scheduler sends one at a
//             time per project, across all members' chats.
export const ControlToCoordinator = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bound"), project: Project }),
  z.object({ type: z.literal("run-turn"), turnId: TurnId, member: ProjectMember, text: z.string() }),
]);
export type ControlToCoordinator = z.infer<typeof ControlToCoordinator>;

// Coordinator → control on the same WebSocket: turn-event and hello, as a bot's worker sends them (chat.ts).
export const CoordinatorToControl = z.discriminatedUnion("type", [TurnEventMessage, TurnHello]);
export type CoordinatorToControl = z.infer<typeof CoordinatorToControl>;

// A member's chat with the project's coordinator as the desktop window shows it.
export const ProjectChatView = z.object({ projectId: ProjectId, items: z.array(ChatItem), working: z.string().nullable() });
export type ProjectChatView = z.infer<typeof ProjectChatView>;
