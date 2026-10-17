import { z } from "zod";

// Branded ids so a BotId can never be passed where a UserId is expected.
export const UserId = z.string().min(1).brand<"UserId">();
export type UserId = z.infer<typeof UserId>;

export const BotId = z.string().min(1).brand<"BotId">();
export type BotId = z.infer<typeof BotId>;

// One user message and the bot's work on it.
export const TurnId = z.string().min(1).brand<"TurnId">();
export type TurnId = z.infer<typeof TurnId>;

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
