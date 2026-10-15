import { Cron } from "croner";

// The first time after `after` (epoch ms) that a cron expression matches in an
// IANA timezone. Null when it never matches again (say, 30 February).
// Throws on an expression or timezone croner cannot read.
export function nextDueAt(cron: string, timezone: string, after: number): number | null {
  return new Cron(cron, { timezone }).nextRun(new Date(after))?.getTime() ?? null;
}
