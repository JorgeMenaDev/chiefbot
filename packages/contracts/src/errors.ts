import { z } from "zod";

// Every error code control answers with. Each error body is an ApiError.
//   unauthorized          no session, bot token, project or task worker credential, or an unknown one (401)
//   wrong_bot             a bot token used for another bot, a project's credential for another project,
//                         or a task worker's for another worker (403)
//   not_found             no such bot or routine for this user, no such workspace or project among
//                         theirs, no such invite for them, no such task, worker or subscription, or no
//                         such project or handoff for a chief of staff (404)
//   reauth_needed         the bot owner (or the member asking a project's coordinator, or creating
//                         a project) must sign in to GitHub again (403, BrokerRefusal)
//   invalid_tokens, invalid_bot, invalid_message, invalid_answer, invalid_routine,
//   invalid_after, invalid_workspace, invalid_invite, invalid_pull_request, invalid_copilot_mode
//                         the body or query failed its schema (400)
//   invalid_schedule      a routine's or schedule subscription's cron or timezone control cannot run (400)
//   model_unavailable     the user's plan does not offer that model, or it is locked (400)
//   github_rejected_token GitHub refused the sign-in's access token (401)
//   computer_failed       the bot's (or project's) computer could not be made or started; `message` says why (502)
//   bot_offline, bot_stopping, turn_running, human_has_screen  a turn was refused (409, TurnRefusal;
//                         turn_running also when a member's last message to a coordinator is unanswered);
//                         bot_stopping also refuses a screen viewer: the computer is stopping
//   not_pending           the approval is answered, unknown, or its turn ended (409)
//   repo_not_found        the bot owner's GitHub account cannot see the repo (404)
//   repo_read_only        the bot owner may not push to the repo (403)
//   app_not_installed     the deployer's repo app is not installed on the repo (403)
//   no_turn               a push or pull request outside a turn: nobody can approve it, or a
//                         connector call outside a turn of the member it runs for (409)
//   declined              the user declined the push or pull request (403)
//   github_failed         GitHub refused what control forwarded; `message` says why (502)
//   owner_only            only the workspace's owner may do that (403)
//   already_member        the invited login is a member already (409)
//   owner_cannot_leave    the workspace's owner cannot leave or be removed (409)
//   invalid_project       the body of POST /workspaces/:id/projects failed its schema (400)
//   invalid_project_file  the repo's chiefbot.project.yaml is missing, unreadable, not YAML or
//                         not a valid project file; `message` says which and where (400)
//   project_exists        the workspace already has a project for that repo (409)
//   invalid_tool_call     a coordinator's or chief's tool call failed its schema or its rules; `message`
//                         says why (400), or no coordinator turn is running (409)
//   copilot_token_failed  GitHub would not mint the organization's Copilot token, e.g. the repo app
//                         lacks Copilot Requests or is not installed on the repo's owner; `message` says why (502)
//   invalid_connector     a connector definition, token or connect request failed its schema or its
//                         connector's auth type; `message` says why (400)
//   connector_exists      the workspace already has a connector of that name (409)
//   invalid_connection    a connection's fields are missing, unknown or empty; `message` says which (400)
//   connector_not_ready   a connector call has no credential: the workspace secret is unset, or the
//                         member has not connected (403)
//   invalid_subscription  a subscription failed its schema, or names a connector that is not a remote
//                         one the project declares; `message` says why (400)
//   requester_only        only the member who asked for a project's worker answers its approvals (403)
//   invalid_turn_key      a call from an agent's computer carried no turn key, an unknown one, another
//                         agent's, or one whose turn ended (403). Never answered with anyone else's turn.
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
  "invalid_copilot_mode",
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
  "copilot_token_failed",
  "invalid_connector",
  "connector_exists",
  "invalid_connection",
  "connector_not_ready",
  "invalid_subscription",
  "invalid_turn_key",
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
