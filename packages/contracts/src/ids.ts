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
