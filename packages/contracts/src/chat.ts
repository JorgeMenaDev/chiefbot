import { z } from "zod";
import { ApprovalId, BotId, HandoffId, TurnId } from "./ids.ts";
import { CopilotPayer } from "./workspaces.ts";

// What a bot asks the user to approve, as the desktop labels it (after T3 Code):
//   push          a git push, which control holds in its git proxy until the answer
//   pull-request  opening a pull request with the bot's create_pull_request tool (control opens it)
//   tool          a GitHub tool that writes
//   connector     a call to a connector's tool its MCP server does not mark read-only, held in control's proxy
//   command       a risky shell command: only in chats from before control held repo access
export const ApprovalKind = z.enum(["push", "pull-request", "tool", "connector", "command"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

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
  z.object({ type: z.literal("done") }),
]);
export type TurnEvent = z.infer<typeof TurnEvent>;

// The message that starts a turn.
export const UserMessage = z.object({ type: z.literal("user-message"), text: z.string() });

// The user's answer to an approval-request of the same turn. Control adds it.
export const ApprovalAnswer = z.object({ type: z.literal("approval-answer"), approvalId: ApprovalId, approved: z.boolean() });
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>;

// Who pays for the turn's Copilot requests. Control adds it when a project's
// coordinator starts the turn, outside the runtime's numbering.
export const TurnPayer = z.object({ type: z.literal("payer"), payer: CopilotPayer });

// Body of POST /bots/:id/approvals/:approvalId (204; 409 when it is not pending).
export const AnswerApprovalRequest = z.object({ approved: z.boolean() });
export type AnswerApprovalRequest = z.infer<typeof AnswerApprovalRequest>;

// Control's note in a chief of staff's chat: a project's task for one of its
// handoffs (handoffs.ts) now needs the owner's input, or is done. Posted once
// each time the task's status becomes one of these, in a turn of its own.
export const HandoffUpdate = z.object({
  type: z.literal("handoff-update"),
  handoffId: HandoffId,
  status: z.enum(["needs_input", "done"]),
  text: z.string(),
});
export type HandoffUpdate = z.infer<typeof HandoffUpdate>;

// One entry of a bot's chat history as control stores it. `seq` grows across all
// of control's chat history, so a client resumes with "everything after seq N".
export const ChatEvent = z.object({
  seq: z.number().int(),
  turnId: TurnId,
  event: z.discriminatedUnion("type", [UserMessage, ApprovalAnswer, HandoffUpdate, TurnPayer, ...TurnEvent.options]),
});
export type ChatEvent = z.infer<typeof ChatEvent>;

// Body of POST /bots/:id/messages, and its 202 answer.
export const SendMessageRequest = z.object({ text: z.string().trim().min(1).max(20_000) });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;
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
  z.object({ kind: z.literal("user"), id: z.string(), text: z.string() }),
  z.object({ kind: z.literal("assistant"), id: z.string(), text: z.string() }),
  z.object({ kind: z.literal("tool"), id: z.string(), name: z.string(), status: z.enum(["running", "succeeded", "failed"]) }),
  z.object({ kind: z.literal("error"), id: z.string(), message: z.string() }),
  // Control's note about a handoff (HandoffUpdate).
  z.object({ kind: z.literal("notice"), id: z.string(), text: z.string() }),
  // Who pays for the turn that follows.
  z.object({ kind: z.literal("payer"), id: z.string(), payer: CopilotPayer }),
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
//               unfinished turn: the runtime lost it.
export const TurnEventMessage = z.object({ type: z.literal("turn-event"), turnId: TurnId, index: z.number().int().min(0), event: TurnEvent });
export const TurnHello = z.object({ type: z.literal("hello"), activeTurnId: TurnId.nullable() });
