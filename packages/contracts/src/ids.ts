import { z } from "zod";

// Branded ids so a BotId can never be passed where a UserId is expected.
export const UserId = z.string().min(1).brand<"UserId">();
export type UserId = z.infer<typeof UserId>;

export const BotId = z.string().min(1).brand<"BotId">();
export type BotId = z.infer<typeof BotId>;

// One user message and the bot's work on it.
export const TurnId = z.string().min(1).brand<"TurnId">();
export type TurnId = z.infer<typeof TurnId>;

// The key of one running turn of an agent (a bot, a project's coordinator or a
// task worker). Control issues it when the turn starts, bound to that agent, the
// member the turn runs for and the turn; it works only while that turn runs, and
// control keeps only its hash. The agent's computer sends it as the bearer on
// every call it makes to control in the turn: that is the only way control
// knows who is acting and in which turn.
export const TurnKey = z.string().min(1).brand<"TurnKey">();
export type TurnKey = z.infer<typeof TurnKey>;

// One thing the bot asked the user to approve (a push, a pull request).
export const ApprovalId = z.string().min(1).brand<"ApprovalId">();
export type ApprovalId = z.infer<typeof ApprovalId>;

// A prompt a bot runs on a schedule.
export const RoutineId = z.string().min(1).brand<"RoutineId">();
export type RoutineId = z.infer<typeof RoutineId>;

// A team: its members share projects, connectors and tasks. Personal bots stay with their owner.
export const WorkspaceId = z.string().min(1).brand<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof WorkspaceId>;

// A pending invitation of one GitHub login to one workspace.
export const InviteId = z.string().min(1).brand<"InviteId">();
export type InviteId = z.infer<typeof InviteId>;

// A project: one repo of a workspace, with its coordinator, shared context and task ledger.
export const ProjectId = z.string().min(1).brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectId>;

// A project's worker: one task on one throwaway computer.
export const TaskWorkerId = z.string().min(1).brand<"TaskWorkerId">();
export type TaskWorkerId = z.infer<typeof TaskWorkerId>;
// One request a person's chief of staff handed to a project.
export const HandoffId = z.string().min(1).brand<"HandoffId">();
export type HandoffId = z.infer<typeof HandoffId>;

// Something a project listens to: CI runs, an issue query or a schedule.
export const SubscriptionId = z.string().min(1).brand<"SubscriptionId">();
export type SubscriptionId = z.infer<typeof SubscriptionId>;

// A file a user sent with a message to their bot.
export const AttachmentId = z.string().min(1).brand<"AttachmentId">();
export type AttachmentId = z.infer<typeof AttachmentId>;
