import { z } from "zod";
import { BotId, RoutineId, TurnId } from "./ids.ts";

// Body of POST /bots/:id/routines and PUT /bots/:id/routines/:routineId.
// `cron` is a cron expression (5 fields, or 6 with seconds) read in `timezone`,
// an IANA name such as "Europe/London". Control rejects ones it cannot schedule.
export const RoutineInput = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(100),
});
export type RoutineInput = z.infer<typeof RoutineInput>;

// One run of a routine, for one due time. Times are epoch milliseconds.
// skipped: control refused its turn (the bot was busy, or someone had its screen).
// `turnId` is the chat turn the run sent, once it got that far.
export const RoutineRun = z.object({
  dueAt: z.number().int(),
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  turnId: TurnId.nullable(),
  error: z.string().nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRun>;

export const Routine = RoutineInput.extend({
  id: RoutineId,
  botId: BotId,
  nextDueAt: z.number().int(),
  lastRun: RoutineRun.nullable(),
});
export type Routine = z.infer<typeof Routine>;
