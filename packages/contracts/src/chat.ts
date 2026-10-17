import { z } from "zod";
import { ApprovalId, BotId, TurnId } from "./ids.ts";

// What a bot asks the user to approve, as the desktop labels it (after T3 Code):
//   push          a git push, which control holds in its git proxy until the answer
//   pull-request  opening a pull request with the bot's create_pull_request tool (control opens it)
//   tool          a GitHub tool that writes
//   command       a risky shell command: only in chats from before control held repo access
export const ApprovalKind = z.enum(["push", "pull-request", "tool", "command"]);
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
  z.object({ type: z.literal("done") }),
]);
export type TurnEvent = z.infer<typeof TurnEvent>;

// The message that starts a turn.
export const UserMessage = z.object({ type: z.literal("user-message"), text: z.string() });

// The user's answer to an approval-request of the same turn. Control adds it.
export const ApprovalAnswer = z.object({ type: z.literal("approval-answer"), approvalId: ApprovalId, approved: z.boolean() });
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>;

// Body of POST /bots/:id/approvals/:approvalId (204; 409 when it is not pending).
export const AnswerApprovalRequest = z.object({ approved: z.boolean() });
export type AnswerApprovalRequest = z.infer<typeof AnswerApprovalRequest>;

// One entry of a bot's chat history as control stores it. `seq` grows across all
// of control's chat history, so a client resumes with "everything after seq N".
export const ChatEvent = z.object({
  seq: z.number().int(),
  turnId: TurnId,
  event: z.discriminatedUnion("type", [UserMessage, ApprovalAnswer, ...TurnEvent.options]),
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

// A bot's chat as the desktop window shows it, folded from ChatEvents.
// Sent from Electron main to the renderer.
export const ChatItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string(), text: z.string() }),
  z.object({ kind: z.literal("assistant"), id: z.string(), text: z.string() }),
  z.object({ kind: z.literal("tool"), id: z.string(), name: z.string(), status: z.enum(["running", "succeeded", "failed"]) }),
  z.object({ kind: z.literal("error"), id: z.string(), message: z.string() }),
  // expired: the turn ended before anyone answered (its worker restarted).
  z.object({
    kind: z.literal("approval"),
    id: z.string(),
    approvalId: ApprovalId,
    request: ApprovalKind,
    detail: z.string(),
    state: z.enum(["pending", "approved", "declined", "expired"]),
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
