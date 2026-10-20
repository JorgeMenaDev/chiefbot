import { z } from "zod";
import { User } from "./auth.ts";
import { SentAttachment, TurnEventMessage, TurnHello, TurnKeyMessage } from "./chat.ts";
import { AgentConnection, ConnectionCallsMessage } from "./connections.ts";
import { AgentConnector } from "./connectors.ts";
import { ApprovalId, BotId, ProjectId, QuestionId, TurnId, TurnKey } from "./ids.ts";
import { ModelReport, ReasoningEffort } from "./models.ts";
import { ProjectStateChange, ProjectStates, ProjectTasks } from "./projects.ts";
import { QuestionResult } from "./questions.ts";
import { ScreenControl } from "./screens.ts";
import { EngineerSetup, ProjectWorkers } from "./taskWorkers.ts";
import { CopilotPayer } from "./workspaces.ts";

// The credential a bot's worker presents to control. Control makes one per bot,
// hands it to the computer at start and keeps only its hash. It is not a GitHub token.
export const BotToken = z.string().min(1).brand<"BotToken">();
export type BotToken = z.infer<typeof BotToken>;

// starting: the computer should run but its worker is not connected yet.
// online:   the worker is connected to control.
// stopping: control is stopping the computer; it takes no new work (409 bot_stopping).
// stopped:  the computer is stopped; its disk is kept.
export const BotStatus = z.enum(["starting", "online", "stopping", "stopped"]);
export type BotStatus = z.infer<typeof BotStatus>;

// A bot's face: one of a fixed set of shapes, all with the same two eyes, in one
// of a fixed set of colours. The desktop draws them (renderer Avatar.tsx).
export const AvatarShape = z.enum(["chief", "circle", "card", "cloud", "hexagon", "flower", "star", "drop", "pill", "seal", "arch", "blob"]);
export type AvatarShape = z.infer<typeof AvatarShape>;
export const AvatarColor = z.enum(["blue", "red", "yellow", "green", "teal", "purple", "pink", "orange", "brown", "graphite"]);
export type AvatarColor = z.infer<typeof AvatarColor>;
export const BotAvatar = z.object({ shape: AvatarShape, color: AvatarColor });
export type BotAvatar = z.infer<typeof BotAvatar>;
// Chiefbot's own chief, in blue: the face of a bot created without one.
export const DEFAULT_AVATAR: BotAvatar = { shape: "chief", color: "blue" };

// How freely a bot's agent acts in its computer before asking its owner (the worker's
// approvals.ts maps each to its permission requests). After T3 Code's runtime modes:
//   supervised         asks before every shell command, file change and connection call
//   auto-accept-edits  changes files freely; asks before anything else that may write
//   auto               asks only before connection CLI writes and GitHub tools that write
//   full-access        asks before nothing (Copilot's "allow all")
// In every mode control still asks before each push and pull request, and the agent
// waits while the owner has its screen.
export const AccessMode = z.enum(["supervised", "auto-accept-edits", "auto", "full-access"]);
export type AccessMode = z.infer<typeof AccessMode>;
export const DEFAULT_ACCESS: AccessMode = "auto";

// `model` is the Copilot model id the bot's turns run on (AUTO_MODEL until the user picks one),
// `effort` its reasoning effort (null: the model's default), `access` its access mode.
export const Bot = z.object({
  id: BotId,
  name: z.string(),
  avatar: BotAvatar,
  status: BotStatus,
  screenControl: ScreenControl,
  model: z.string(),
  effort: ReasoningEffort.nullable(),
  access: AccessMode,
});
export type Bot = z.infer<typeof Bot>;

// Body of PUT /bots/:id/access.
export const SetBotAccessRequest = z.object({ access: AccessMode });
export type SetBotAccessRequest = z.infer<typeof SetBotAccessRequest>;

// Body of POST /bots.
export const CreateBotRequest = z.object({ name: z.string().trim().min(1).max(60), avatar: BotAvatar.default(DEFAULT_AVATAR) });
export type CreateBotRequest = z.infer<typeof CreateBotRequest>;

// Control → desktop on the /events WebSocket.
//   bots   the user's bots; sent on connect and on every change
//   user   the user changed: their GitHub sign-in was lost or restored
//   tasks    the whole task ledger of one of the user's projects; sent on every change
//   workers  every worker of one of the user's projects; sent on every change
//   project-states  every project of the user's workspaces with its state dot for them (projects.ts
//           projectState), replacing what they had: on connect, and once a project of theirs goes
//   project-state  one of those projects' new state dot for them, on every change
export const ClientEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bots"), bots: z.array(Bot) }),
  z.object({ type: z.literal("user"), user: User }),
  ProjectTasks.extend({ type: z.literal("tasks") }),
  ProjectWorkers.extend({ type: z.literal("workers") }),
  z.object({ type: z.literal("project-states"), states: ProjectStates }),
  ProjectStateChange.extend({ type: z.literal("project-state") }),
]);
export type ClientEvent = z.infer<typeof ClientEvent>;

// Control → worker on the /worker WebSocket.
//   bound           control accepted the credential; sent right after. The connection belongs to
//                   that one bot (or, on /task-worker, that one task worker).
//   run-turn        run one turn on the bot's Copilot session, on `model` at `effort` (null: the model's
//                   default), asking as its `access` mode says; control sends one at a time.
//                   `turnKey` is the turn's key (ids.ts TurnKey): the bearer of every call to control in it.
//                   `connections` are the owner's connections that are on (connections.ts), for this turn only.
//                   `attachments` are the files sent with the message: the worker reads each from control with the turn's key.
//   run-task        a task worker's only turn, its task: on the Copilot of `payer`, with `connectors`
//                   (control's proxy runs them as the member who asked), and its `turnKey`. It sets
//                   up as `setup` says before its agent starts (taskWorkers.ts EngineerSetup). Sent
//                   once, after its first hello.
//   turn-key        the running turn's new key (chat.ts TurnKeyMessage)
//   screen-control  who drives the screen; sent after bound and on every take-over and hand-back
//   screen-open     a viewer is waiting: dial /worker/:botId/screen/:streamId and pipe the screen's VNC bytes through it
//   approval-answer the user's answer to one of the worker's approval-requests.
//                   Sent when the user answers and again after every hello for the
//                   active turn's answered approvals; the worker ignores repeats.
//   question-answer the user's answer to one of the worker's question-requests, sent
//                   and resent like approval-answer.
export const ControlToWorker = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bound") }),
  z.object({
    type: z.literal("run-turn"),
    turnId: TurnId,
    turnKey: TurnKey,
    text: z.string(),
    model: z.string(),
    effort: ReasoningEffort.nullable().default(null),
    access: AccessMode.default(DEFAULT_ACCESS),
    connections: z.array(AgentConnection).default([]),
    attachments: z.array(SentAttachment).default([]),
  }),
  z.object({
    type: z.literal("run-task"),
    turnId: TurnId,
    turnKey: TurnKey,
    text: z.string(),
    payer: CopilotPayer,
    connectors: z.array(AgentConnector),
    setup: EngineerSetup,
  }),
  z.object({ type: z.literal("screen-control"), control: ScreenControl }),
  z.object({ type: z.literal("screen-open"), streamId: z.string().min(1) }),
  z.object({ type: z.literal("approval-answer"), approvalId: ApprovalId, approved: z.boolean() }),
  z.object({ type: z.literal("question-answer"), questionId: QuestionId, result: QuestionResult }),
  TurnKeyMessage,
]);
export type ControlToWorker = z.infer<typeof ControlToWorker>;

// Worker → control on the /worker WebSocket.
//   turn-event, hello  see chat.ts
//   models      the models the bot owner's Copilot plan offers; sent after every bind
//   connection-calls  see connections.ts
export const WorkerToControl = z.discriminatedUnion("type", [
  TurnEventMessage,
  TurnHello,
  z.object({ type: z.literal("models"), report: ModelReport }),
  ConnectionCallsMessage,
]);
export type WorkerToControl = z.infer<typeof WorkerToControl>;
