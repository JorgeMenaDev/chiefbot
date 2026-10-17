import { z } from "zod";

// Every error code control answers with. Each error body is an ApiError.
//   unauthorized          no session, bot token, project or task worker credential, or an unknown one (401)
//   wrong_bot             a bot token used for another bot, a project's credential for another project,
//                         or a task worker's for another worker (403)
//   not_found             no such bot or routine for this user, no such workspace or project among
//                         theirs, no such invite for them, or no such task or worker (404)
//   reauth_needed         the bot owner (or the member asking a project's coordinator, or creating
//                         a project) must sign in to GitHub again (403, BrokerRefusal)
//   invalid_tokens, invalid_bot, invalid_message, invalid_answer, invalid_routine,
//   invalid_after, invalid_workspace, invalid_invite, invalid_pull_request
//                         the body or query failed its schema (400)
//   invalid_schedule      a routine's cron or timezone control cannot run (400)
//   model_unavailable     the user's plan does not offer that model, or it is locked (400)
//   github_rejected_token GitHub refused the sign-in's access token (401)
//   computer_failed       the bot's (or project's) computer could not be made or started; `message` says why (502)
//   bot_offline, bot_stopping, turn_running, human_has_screen  a turn was refused (409, TurnRefusal;
//                         turn_running also when a member's last message to a coordinator is unanswered);
//                         bot_stopping also refuses a screen viewer: the computer is stopping
//   not_pending           the approval is answered, unknown, or its turn ended (409)
//   repo_not_found        the bot owner's GitHub account cannot see the repo (404)
//   repo_read_only        the bot owner may not push to the repo (403)
//   app_not_installed     the deployer's GitHub App is not installed on the repo (403)
//   no_turn               a push or pull request outside a turn: nobody can approve it (409)
//   declined              the user declined the push or pull request (403)
//   github_failed         GitHub refused what control forwarded; `message` says why (502)
//   owner_only            only the workspace's owner may do that (403)
//   already_member        the invited login is a member already (409)
//   owner_cannot_leave    the workspace's owner cannot leave or be removed (409)
//   invalid_project       the body of POST /workspaces/:id/projects failed its schema (400)
//   invalid_project_file  the repo's chiefbot.project.yaml is missing, unreadable, not YAML or
//                         not a valid project file; `message` says which and where (400)
//   project_exists        the workspace already has a project for that repo (409)
//   invalid_tool_call     a coordinator tool call failed its schema or its rules; `message` says why (400),
//                         or no coordinator turn is running (409)
//   requester_only        only the member who asked for a project's worker answers its approvals (403)
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
  "invalid_pull_request",
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
  "repo_not_found",
  "repo_read_only",
  "app_not_installed",
  "no_turn",
  "declined",
  "github_failed",
  "owner_only",
  "already_member",
  "owner_cannot_leave",
  "invalid_project",
  "invalid_project_file",
  "project_exists",
  "invalid_tool_call",
  "requester_only",
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
