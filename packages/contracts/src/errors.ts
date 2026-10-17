import { z } from "zod";

// Every error code control answers with. Each error body is an ApiError.
//   unauthorized          no session or bot token, or an unknown one (401)
//   wrong_bot             a bot token used for another bot (403)
//   not_found             no such bot or routine for this user, no such workspace among
//                         theirs, or no such invite for them (404)
//   reauth_needed         the bot owner must sign in to GitHub again (403, BrokerRefusal)
//   invalid_tokens, invalid_bot, invalid_message, invalid_answer, invalid_routine,
//   invalid_after, invalid_workspace, invalid_invite
//                         the body or query failed its schema (400)
//   invalid_schedule      a routine's cron or timezone control cannot run (400)
//   model_unavailable     the user's plan does not offer that model, or it is locked (400)
//   github_rejected_token GitHub refused the sign-in's access token (401)
//   computer_failed       the bot's computer could not be made or started; `message` says why (502)
//   bot_offline, bot_stopping, turn_running, human_has_screen  a turn was refused (409, TurnRefusal);
//                         bot_stopping also refuses a screen viewer: the computer is stopping
//   not_pending           the approval is answered, unknown, or its turn ended (409)
//   owner_only            only the workspace's owner may do that (403)
//   already_member        the invited login is a member already (409)
//   owner_cannot_leave    the workspace's owner cannot leave or be removed (409)
//   expected_websocket    a WebSocket route got a plain request (400)
export const ApiErrorCode = z.enum([
  "unauthorized",
  "wrong_bot",
  "not_found",
  "reauth_needed",
  "invalid_tokens",
  "invalid_bot",
  "invalid_message",
  "invalid_answer",
  "invalid_routine",
  "invalid_after",
  "invalid_workspace",
  "invalid_invite",
  "invalid_schedule",
  "model_unavailable",
  "github_rejected_token",
  "computer_failed",
  "bot_offline",
  "bot_stopping",
  "turn_running",
  "human_has_screen",
  "not_pending",
  "owner_only",
  "already_member",
  "owner_cannot_leave",
  "expected_websocket",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({ error: ApiErrorCode, message: z.string().optional() });
export type ApiError = z.infer<typeof ApiError>;

// Why control refused to start a turn: a user's message or a routine's prompt.
export const TurnRefusal = ApiErrorCode.extract(["bot_offline", "bot_stopping", "turn_running", "human_has_screen"]);
export type TurnRefusal = z.infer<typeof TurnRefusal>;

// The broker's 403 when control holds no usable GitHub sign-in for the bot's
// owner (it expired, GitHub revoked it, or the owner disconnected GitHub). Bots
// get no token until the owner signs in again in the desktop app.
export const BrokerRefusal = z.object({ error: ApiErrorCode.extract(["reauth_needed"]) });
export type BrokerRefusal = z.infer<typeof BrokerRefusal>;
