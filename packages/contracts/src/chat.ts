import { z } from "zod";
import { BotId, TurnId } from "./ids.ts";

// What happens during one turn, as the worker reports it. The worker turns
// Copilot SDK session events into these; a turn always ends with `done`.
//   text-delta  a chunk of an assistant message; chunks of one message share messageId
//   tool-call   a tool started (running) or finished; updates share toolCallId
//   status      what the bot says it is doing now ("Reading the repo")
//   error       the turn failed; `done` follows
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
  z.object({ type: z.literal("done") }),
]);
export type TurnEvent = z.infer<typeof TurnEvent>;

// The message that starts a turn.
export const UserMessage = z.object({ type: z.literal("user-message"), text: z.string() });

// One entry of a bot's chat history as control stores it. `seq` grows across all
// of control's chat history, so a client resumes with "everything after seq N".
export const ChatEvent = z.object({
  seq: z.number().int(),
  turnId: TurnId,
  event: z.discriminatedUnion("type", [UserMessage, ...TurnEvent.options]),
});
export type ChatEvent = z.infer<typeof ChatEvent>;

// Body of POST /bots/:id/messages, and its 202 answer.
export const SendMessageRequest = z.object({ text: z.string().trim().min(1).max(20_000) });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;
export const SendMessageResponse = z.object({ turnId: TurnId });
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

// Response of GET /worker/github-token: the bot owner's GitHub access token for
// the Copilot SDK. Never a refresh token. expiresAt is epoch milliseconds.
export const BrokeredGitHubToken = z.object({ accessToken: z.string().min(1), expiresAt: z.number().int() });
export type BrokeredGitHubToken = z.infer<typeof BrokeredGitHubToken>;

// A bot's chat as the desktop window shows it, folded from ChatEvents.
// Sent from Electron main to the renderer.
export const ChatItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string(), text: z.string() }),
  z.object({ kind: z.literal("assistant"), id: z.string(), text: z.string() }),
  z.object({ kind: z.literal("tool"), id: z.string(), name: z.string(), status: z.enum(["running", "succeeded", "failed"]) }),
  z.object({ kind: z.literal("error"), id: z.string(), message: z.string() }),
]);
export type ChatItem = z.infer<typeof ChatItem>;

// `working` is set while a turn runs: the bot's latest status, or "" before it has one.
export const ChatView = z.object({
  botId: BotId,
  items: z.array(ChatItem),
  working: z.string().nullable(),
});
export type ChatView = z.infer<typeof ChatView>;
