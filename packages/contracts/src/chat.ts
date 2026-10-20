import { z } from "zod";
import { ApprovalId, AttachmentId, BotId, HandoffId, ProjectId, QuestionId, TurnId, TurnKey, WorkspaceId } from "./ids.ts";
import { QuestionForm, QuestionResult } from "./questions.ts";
import { VerdictLine } from "./verification.ts";
import { CopilotPayer } from "./workspaces.ts";

// What a bot asks the user to approve, as the desktop labels it (after T3 Code):
//   push          a git push, which control holds in its git proxy until the answer
//   pull-request  opening a pull request with the bot's create_pull_request tool (control opens it)
//   tool          a GitHub tool that writes
//   connector     a call to a connector's tool its MCP server does not mark read-only, held in control's proxy,
//                 or a run of a connection's CLI that may write
//   command       a shell command, when the bot's access mode asks before it (bots.ts AccessMode); in
//                 chats from before control held repo access, a risky one
//   file-change   a file the agent writes, when the bot's access mode is supervised
export const ApprovalKind = z.enum(["push", "pull-request", "tool", "connector", "command", "file-change"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

// The most of a setup step's output an engineer keeps: the end of it.
export const SETUP_LOG_MAX = 16_384;

// One step of an engineer's setup (a project's task worker), before its agent
// starts: the command it ran, how it ended and the end of its output.
//   clone     clones the project's repo from its default branch, through control's git proxy
//   checkout  a verifier's: fetches the commit it checks and checks it out
//   setup     the project's commands.setup, in the clone, with the project's secrets in its environment
export const SetupStep = z.object({
  step: z.enum(["clone", "checkout", "setup"]),
  command: z.string(),
  exitCode: z.int(),
  log: z.string().max(SETUP_LOG_MAX),
});
export type SetupStep = z.infer<typeof SetupStep>;

// What happens during one turn, as the worker reports it. The worker turns
// Copilot SDK session events into these; a turn always ends with `done`.
//   text-delta  a chunk of an assistant message; chunks of one message share messageId
//   tool-call   a tool started (running) or finished; updates share toolCallId
//   status      what the bot says it is doing now ("Reading the repo")
//   error       the turn failed; `done` follows
//   approval-request  the bot waits until the user approves or declines this
//               (POST /bots/:id/approvals/:approvalId). Control records it. Control
//               adds its own for pushes and pull requests, outside the worker's numbering.
//   approval-withdrawn  the agent no longer waits on that approval-request, which can
//               no longer be answered: a task worker's runtime was cut short to renew
//               its token, or the request control held for it went away.
//   question-request  the bot's agent asks the user `form` and waits for the answer
//               (POST /bots/:id/questions/:questionId). Control records it.
//   question-withdrawn  the agent no longer waits on that question, which can no
//               longer be answered: the SDK ended it, its turn ended, or the bot was stopped
//               (control adds that one).
//   setup-step  an engineer ran one step of its setup (SetupStep), before its agent starts.
//               A step that fails ends the turn: the engineer is blocked.
//   setup-done  the engineer's setup is over and its agent starts, with the repo's
//               instruction files and skill folders it found
export const TurnEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text-delta"), messageId: z.string(), text: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    name: z.string(),
    status: z.enum(["running", "succeeded", "failed"]),
  }),
  z.object({ type: z.literal("status"), text: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("approval-request"), approvalId: ApprovalId, kind: ApprovalKind, detail: z.string() }),
  z.object({ type: z.literal("approval-withdrawn"), approvalId: ApprovalId }),
  z.object({ type: z.literal("question-request"), questionId: QuestionId, form: QuestionForm }),
  z.object({ type: z.literal("question-withdrawn"), questionId: QuestionId }),
  z.object({ type: z.literal("setup-step"), step: SetupStep }),
  z.object({ type: z.literal("setup-done"), instructions: z.array(z.string()), skills: z.array(z.string()) }),
  z.object({ type: z.literal("done") }),
]);
export type TurnEvent = z.infer<typeof TurnEvent>;

// Files a user sends with a message to their bot (POST /bots/:id/messages): at
// most MAX_ATTACHMENTS, each at most MAX_ATTACHMENT_BYTES, with distinct names.
// The worker saves each in the bot's workspace under its name, so a name is one
// file name, never a path.
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const AttachmentName = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !/[/\\\0]/.test(name) && name !== "." && name !== "..", "A file name, without a folder");

// The size of the bytes a valid base64 string holds.
const decodedSize = (base64: string) => (base64.length / 4) * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

// A file's type, such as image/png, without parameters.
export const MimeType = z.string().max(255).regex(/^[\w.+-]+\/[\w.+-]+$/);

// One file as the desktop sends it, its bytes in base64.
export const AttachmentUpload = z.object({
  name: AttachmentName,
  mimeType: MimeType,
  data: z.base64().refine((data) => decodedSize(data) <= MAX_ATTACHMENT_BYTES, "A file can be at most 10 MB."),
});
export type AttachmentUpload = z.infer<typeof AttachmentUpload>;

// One file of a sent message, as control keeps it. `size` is in bytes. Its
// owner reads it at GET /bots/:id/attachments/:attachmentId, and the worker of
// its turn at GET /worker/:botId/attachments/:attachmentId.
export const SentAttachment = z.object({ id: AttachmentId, name: AttachmentName, mimeType: z.string(), size: z.number().int() });
export type SentAttachment = z.infer<typeof SentAttachment>;

// The message that starts a turn, with the files sent with it (none before files could be sent).
export const UserMessage = z.object({ type: z.literal("user-message"), text: z.string(), attachments: z.array(SentAttachment).optional() });
export type UserMessage = z.infer<typeof UserMessage>;

// The user's answer to an approval-request of the same turn. Control adds it.
export const ApprovalAnswer = z.object({ type: z.literal("approval-answer"), approvalId: ApprovalId, approved: z.boolean() });
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>;

// The user's answer to a question-request of the same turn. Control adds it.
export const QuestionAnswer = z.object({ type: z.literal("question-answer"), questionId: QuestionId, result: QuestionResult });
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

// Why a turn runs on Auto rather than the project's `model`: the payer's plan
// does not offer it (not_on_plan), or no turn on that plan has listed its models yet (plan_unknown).
export const AutoFallback = z.object({ model: z.string(), reason: z.enum(["not_on_plan", "plan_unknown"]) });
export type AutoFallback = z.infer<typeof AutoFallback>;

// Who pays for the turn's Copilot requests. Control adds it when a project's
// coordinator starts the turn, outside the runtime's numbering. `fallback` is
// null when the turn runs on the project's model.
export const TurnPayer = z.object({ type: z.literal("payer"), payer: CopilotPayer, fallback: AutoFallback.nullable().default(null) });

// Body of POST /bots/:id/approvals/:approvalId (204; 409 when it is not pending).
export const AnswerApprovalRequest = z.object({ approved: z.boolean() });
export type AnswerApprovalRequest = z.infer<typeof AnswerApprovalRequest>;

// Where a handoff (handoffs.ts) stands, as its card in the chief's chat says it,
// from its task in the ledger:
//   accepted     the task is open: the project has it
//   working      the task is in progress
//   needs_input  the task waits on the owner's answer to `question`
//   pr_opened    the task, in progress or open, links a pull request
//   verified     and a verifier passed that pull request's head
//   done, abandoned  the task is closed
export const HandoffStage = z.enum(["accepted", "working", "needs_input", "pr_opened", "verified", "done", "abandoned"]);
export type HandoffStage = z.infer<typeof HandoffStage>;

// What a handoff's card in its chief's chat shows. `project` is the project's
// name; `question` is set only at needs_input; `pullRequests` are the task's;
// `verification` is its verdict on the latest of them, or null for none.
export const HandoffCard = z.object({
  handoffId: HandoffId,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  project: z.string(),
  title: z.string(),
  taskNumber: z.number().int().min(1),
  stage: HandoffStage,
  question: z.string().nullable(),
  pullRequests: z.array(z.url()),
  verification: VerdictLine.nullable().default(null),
});
export type HandoffCard = z.infer<typeof HandoffCard>;

// Control's note in a chief of staff's chat: its handoff's card, whole. Posted
// when the chief hands the work over and again whenever what the card shows
// changes, each in a turn of its own. The desktop shows one card per handoff,
// where it first appeared, with the latest of these.
export const HandoffCardEvent = z.object({ type: z.literal("handoff-card"), card: HandoffCard });
export type HandoffCardEvent = z.infer<typeof HandoffCardEvent>;

// Control's note in chats from before handoff cards: the handoff's task needed
// the owner's input, or was done. Control posts no more of them.
export const HandoffUpdate = z.object({
  type: z.literal("handoff-update"),
  handoffId: HandoffId,
  status: z.enum(["needs_input", "done"]),
  text: z.string(),
});

// One entry of a bot's chat history as control stores it. `seq` grows across all
// of control's chat history, so a client resumes with "everything after seq N".
export const ChatEvent = z.object({
  seq: z.number().int(),
  turnId: TurnId,
  event: z.discriminatedUnion("type", [UserMessage, ApprovalAnswer, QuestionAnswer, HandoffCardEvent, HandoffUpdate, TurnPayer, ...TurnEvent.options]),
});
export type ChatEvent = z.infer<typeof ChatEvent>;

// Body of POST /projects/:id/messages, and the text of a bot's message.
export const SendMessageRequest = z.object({ text: z.string().trim().min(1).max(20_000) });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;
// Body of POST /bots/:id/messages: the text and its files. Its answer is a SendMessageResponse (202).
export const SendBotMessageRequest = SendMessageRequest.extend({
  attachments: z
    .array(AttachmentUpload)
    .max(MAX_ATTACHMENTS, `A message can have at most ${MAX_ATTACHMENTS} files.`)
    .refine((files) => new Set(files.map(({ name }) => name)).size === files.length, "Each file of a message needs its own name.")
    .default([]),
});
export type SendBotMessageRequest = z.infer<typeof SendBotMessageRequest>;
export const SendMessageResponse = z.object({ turnId: TurnId });
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

// Response of GET /worker/:botId/github-token: the bot owner's GitHub access token
// for the Copilot SDK, with more than two hours left. Never a refresh token.
// expiresAt is epoch milliseconds.
export const BrokeredGitHubToken = z.object({ accessToken: z.string().min(1), expiresAt: z.number().int() });
export type BrokeredGitHubToken = z.infer<typeof BrokeredGitHubToken>;

// Response of GET /coordinator/:projectId/installation-token: a one-hour
// installation token of the repo app that may only make Copilot requests, for a
// turn the organization pays for. The runtime gets it as COPILOT_GITHUB_TOKEN.
// expiresAt is epoch milliseconds.
export const CopilotInstallationToken = z.object({ token: z.string().min(1), expiresAt: z.number().int() });
export type CopilotInstallationToken = z.infer<typeof CopilotInstallationToken>;

// A bot's chat as the desktop window shows it, folded from ChatEvents.
// Sent from Electron main to the renderer.
export const ChatItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string(), text: z.string(), attachments: z.array(SentAttachment).optional() }),
  z.object({ kind: z.literal("assistant"), id: z.string(), text: z.string() }),
  z.object({ kind: z.literal("tool"), id: z.string(), name: z.string(), status: z.enum(["running", "succeeded", "failed"]) }),
  z.object({ kind: z.literal("error"), id: z.string(), message: z.string() }),
  // A handoff's card (HandoffCardEvent), as its latest event says.
  HandoffCard.extend({ kind: z.literal("handoff"), id: z.string() }),
  // Control's note about a handoff, from before cards (HandoffUpdate).
  z.object({ kind: z.literal("notice"), id: z.string(), text: z.string() }),
  // Who pays for the turn that follows.
  z.object({ kind: z.literal("payer"), id: z.string(), payer: CopilotPayer, fallback: AutoFallback.nullable().default(null) }),
  // expired: the turn ended before anyone answered (its worker restarted).
  // withdrawn: the agent stopped waiting on it (approval-withdrawn); the turn goes on.
  z.object({
    kind: z.literal("approval"),
    id: z.string(),
    approvalId: ApprovalId,
    request: ApprovalKind,
    detail: z.string(),
    state: z.enum(["pending", "approved", "declined", "expired", "withdrawn"]),
  }),
  // A question card. answered: `answer` is the user's (accept or decline).
  // expired: the turn ended before anyone answered (its worker restarted).
  // withdrawn: the agent stopped waiting on it (question-withdrawn).
  z.object({
    kind: z.literal("question"),
    id: z.string(),
    questionId: QuestionId,
    form: QuestionForm,
    state: z.enum(["pending", "answered", "expired", "withdrawn"]),
    answer: QuestionResult.optional(),
  }),
]);
export type ChatItem = z.infer<typeof ChatItem>;

// `working` is set while a turn runs: the bot's latest status, or "" before it has one.
export const ChatView = z.object({
  botId: BotId,
  items: z.array(ChatItem),
  working: z.string().nullable(),
});
export type ChatView = z.infer<typeof ChatView>;

// What an agent's runtime (a bot's worker or a project's coordinator) sends control about its turns.
//   turn-event  event number `index` (0, 1, 2…) of a turn
//   hello       the turn it is still running, if any. Sent on every (re)connect,
//               after it has resent every event of its latest turn. Control stores
//               each index once, so resends are harmless, then ends every other
//               unfinished turn: the runtime lost it. `capabilities` name what the
//               runtime does beyond the first protocol (ACCESS_MODES, ATTACHMENTS,
//               ENGINEER_SETUP, VERIFIER); an older one sends none.
export const TurnEventMessage = z.object({ type: z.literal("turn-event"), turnId: TurnId, index: z.number().int().min(0), event: TurnEvent });
export const TurnHello = z.object({ type: z.literal("hello"), activeTurnId: TurnId.nullable(), capabilities: z.array(z.string()).default([]) });

// A bot's worker that asks as the turn's access mode says. One without it drops
// the mode and asks as Auto does, so control sends it only Auto turns.
export const ACCESS_MODES = "access-modes";
// A bot's worker that gives a turn's files to its session. One without it drops
// them, so control sends it only turns without files.
export const ATTACHMENTS = "attachments";
// A task worker that sets up before its agent starts (an engineer: EngineerSetup).
// One without it would ignore the setup and start its agent bare, so control
// gives it no task: it ends blocked, asking for a rebuilt computer image.
export const ENGINEER_SETUP = "engineer-setup";
// A task worker that can be a verifier: it checks out the commit its setup names,
// has report_verdict and no create_pull_request. Control gives one without it no
// verifier's task: it ends blocked, asking for a rebuilt computer image.
export const VERIFIER = "verifier";

// Control → an agent's runtime, after a hello naming a turn that still runs whose
// key control no longer has (control restarted, which revokes every key): the
// turn's new key, which replaces the old one from now on.
export const TurnKeyMessage = z.object({ type: z.literal("turn-key"), turnId: TurnId, turnKey: TurnKey });
