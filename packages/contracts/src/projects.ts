import { z } from "zod";
import { ChatItem, TurnEventMessage, TurnHello, TurnKeyMessage } from "./chat.ts";
import { AgentConnector, ConnectorName } from "./connectors.ts";
import { ProjectId, TaskWorkerId, TurnId, TurnKey, UserId, WorkspaceId } from "./ids.ts";
import { RepoFullName } from "./repos.ts";
import type { TaskWorker } from "./taskWorkers.ts";
import { CopilotPayer } from "./workspaces.ts";

// A file or folder inside the repo, relative to its root: no leading slash and no "." or ".." part.
const RepoPath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((path) => path.replace(/\/$/, "").split("/").every((part) => part !== "" && part !== "." && part !== ".."), "expected a path inside the repo, like docs/agents.md");

// A project secret's name: the environment variable a worker gets it as.
export const SecretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/, "expected an environment variable name, like API_KEY");
export type SecretName = z.infer<typeof SecretName>;

const Command = z.string().trim().min(1).max(2000);
//   setup   runs in a worker's clone before its agent starts
//   build, test  how to build and test the repo
//   dev     starts the app, and devUrl is where it then answers
export const ProjectCommands = z.strictObject({
  setup: Command.optional(),
  build: Command.optional(),
  test: Command.optional(),
  dev: Command.optional(),
  devUrl: z.url({ protocol: /^https?$/ }).optional(),
});
export type ProjectCommands = z.infer<typeof ProjectCommands>;

// A stdio MCP server that runs inside the project's workers only.
export const ProjectMcpServer = z.strictObject({ command: z.string().trim().min(1).max(500), args: z.array(z.string().max(2000)).max(50).default([]) });
// The stdio servers by name. A record drops a "__proto__" key without a word,
// so one is refused before it gets there.
const ProjectMcpServers = z
  .custom<object>((servers) => typeof servers !== "object" || servers === null || !Object.hasOwn(servers, "__proto__"), "__proto__ cannot name a server")
  .pipe(z.record(ConnectorName, ProjectMcpServer));

// The repo's chiefbot.project.yaml, at its root on the default branch, and the
// project's settings in the app: the same keys, every one optional. Unknown keys
// are errors, so a typo is caught instead of ignored.
//   instructions  files the agents read besides AGENTS.md
//   commands      the repo's commands (ProjectCommands)
//   skills        folders of skills the agents load
//   verify        the skill a verifier follows
//   connectors    the connectors (MCP servers) of the workspace the project's agents need, by name
//   mcp           stdio MCP servers, by name, that run inside workers only
//   secrets       the names of the project's secrets; members set their values in the app
//   workers.max   how many worker computers the project runs at once
export const ProjectFile = z.strictObject({
  instructions: z.array(RepoPath).max(50).optional(),
  commands: ProjectCommands.optional(),
  skills: z.array(RepoPath).max(50).optional(),
  verify: z.string().trim().min(1).max(100).optional(),
  connectors: z.array(z.string().trim().min(1)).optional(),
  mcp: ProjectMcpServers.optional(),
  secrets: z.array(SecretName).max(50).optional(),
  workers: z.strictObject({ max: z.int().min(1).max(10).optional() }).optional(),
});
export type ProjectFile = z.infer<typeof ProjectFile>;

// The file name control reads at the repo's root.
export const projectFileName = "chiefbot.project.yaml";

// What control found at the repo's root when the project was made. A project
// works without a file, or with an invalid one: it then uses its settings alone.
export const ProjectFileState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), file: ProjectFile }),
  z.object({ status: z.literal("missing") }),
  z.object({ status: z.literal("invalid"), error: z.string() }),
]);
export type ProjectFileState = z.infer<typeof ProjectFileState>;

export const DEFAULT_WORKERS_MAX = 2;

// The config a project's agents use: the settings over the file, then the defaults.
export const ProjectConfig = z.object({
  instructions: z.array(RepoPath).default([]),
  commands: ProjectCommands.default({}),
  skills: z.array(RepoPath).default([]),
  verify: z.string().optional(),
  connectors: z.array(z.string()).default([]),
  mcp: z.record(ConnectorName, ProjectMcpServer).default({}),
  secrets: z.array(SecretName).default([]),
  workers: z.object({ max: z.int().default(DEFAULT_WORKERS_MAX) }).default({ max: DEFAULT_WORKERS_MAX }),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

// Each key the settings and the file set, and where the config takes it from. A
// key neither sets is absent: its default applies.
export const ConfigKey = z.enum([
  "instructions",
  "commands.setup",
  "commands.build",
  "commands.test",
  "commands.dev",
  "commands.devUrl",
  "skills",
  "verify",
  "connectors",
  "mcp",
  "secrets",
  "workers.max",
]);
export type ConfigKey = z.infer<typeof ConfigKey>;
export const ConfigSources = z.partialRecord(ConfigKey, z.enum(["file", "settings"]));
export type ConfigSources = z.infer<typeof ConfigSources>;

// The config from the repo's file (null when it has none, or an invalid one) and
// the settings: each key from the settings when they set it, else from the file.
// `commands` and `workers` merge key by key; any other key is taken whole, so
// `connectors: []` in the settings clears the file's list.
export function effectiveConfig(file: ProjectFile | null, settings: ProjectFile): { config: ProjectConfig; sources: ConfigSources } {
  const sources: ConfigSources = {};
  const pick = <T>(key: ConfigKey, fromSettings: T | undefined, fromFile: T | undefined) => {
    if (fromSettings !== undefined) sources[key] = "settings";
    else if (fromFile !== undefined) sources[key] = "file";
    return fromSettings ?? fromFile;
  };
  const command = (name: keyof ProjectCommands) => {
    const line = pick(`commands.${name}`, settings.commands?.[name], file?.commands?.[name]);
    return line === undefined ? {} : { [name]: line };
  };
  const config = ProjectConfig.parse({
    instructions: pick("instructions", settings.instructions, file?.instructions),
    commands: { ...command("setup"), ...command("build"), ...command("test"), ...command("dev"), ...command("devUrl") },
    skills: pick("skills", settings.skills, file?.skills),
    verify: pick("verify", settings.verify, file?.verify),
    connectors: pick("connectors", settings.connectors, file?.connectors),
    mcp: pick("mcp", settings.mcp, file?.mcp),
    secrets: pick("secrets", settings.secrets, file?.secrets),
    workers: { max: pick("workers.max", settings.workers?.max, file?.workers?.max) },
  });
  return { config, sources };
}

// A project as a member of its workspace sees it. `name` is the repo's name.
// `settings` is the YAML members saved in the app (ProjectFile's keys); `config`
// and `sources` are effectiveConfig of the file and the settings.
export const Project = z.object({
  id: ProjectId,
  workspaceId: WorkspaceId,
  name: z.string(),
  repo: RepoFullName,
  file: ProjectFileState,
  settings: z.string(),
  config: ProjectConfig,
  sources: ConfigSources,
});
export type Project = z.infer<typeof Project>;

// Body of PUT /projects/:id/settings: the settings as YAML, ProjectFile's keys.
export const ProjectSettingsRequest = z.object({ text: z.string().max(20_000) });
export type ProjectSettingsRequest = z.infer<typeof ProjectSettingsRequest>;

// One of the project's secrets as members see it: never its value. `declared`
// when the config lists it; `set` when control holds a value for it. A value
// whose name the config no longer lists stays until a member clears it.
export const ProjectSecret = z.object({ name: SecretName, declared: z.boolean(), set: z.boolean() });
export type ProjectSecret = z.infer<typeof ProjectSecret>;

// Body of PUT /projects/:id/secrets/:name: the secret's new value.
export const SetProjectSecretRequest = z.object({ value: z.string().min(1).max(16_384) });
export type SetProjectSecretRequest = z.infer<typeof SetProjectSecretRequest>;

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

// One shared context file's Markdown, as a member reads it.
export const ContextFileText = z.object({ path: ContextPath, content: z.string() });
export type ContextFileText = z.infer<typeof ContextFileText>;

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
// created it. `question` is what it waits on while it needs input, else null.
// Times are epoch milliseconds.
export const Task = z.object({
  projectId: ProjectId,
  number: z.number().int().min(1),
  title: z.string(),
  detail: z.string(),
  status: TaskStatus,
  question: z.string().nullable(),
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

// The dot beside a project in the Projects tab, for one member:
//   needs_you  a task they asked for waits on their answer, or an engineer they asked for waits on their approval
//   working    the project agent has a message to answer, or an engineer runs
//   sleeping   the project's computer is stopped while idle; the next message wakes it
//   idle       none of these
export const ProjectState = z.enum(["idle", "working", "needs_you", "sleeping"]);
export type ProjectState = z.infer<typeof ProjectState>;

// The member `login`'s state of a project: `awake` while its computer runs the
// project agent, `busy` while the agent has a message of any member to answer.
export function projectState({ login, awake, busy, tasks, workers }: { login: string; awake: boolean; busy: boolean; tasks: Task[]; workers: TaskWorker[] }): ProjectState {
  const asked = tasks.some(({ status, requestedBy }) => status === "needs_input" && requestedBy === login);
  const approve = workers.some(({ pendingApprovals, requestedBy }) => pendingApprovals.length > 0 && requestedBy === login);
  if (asked || approve) return "needs_you";
  if (busy || workers.some(({ state }) => state === "launching" || state === "working")) return "working";
  return awake ? "idle" : "sleeping";
}

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
  question: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .optional()
    .describe("With status needs_input: the one specific question a person must answer for the work to go on"),
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
