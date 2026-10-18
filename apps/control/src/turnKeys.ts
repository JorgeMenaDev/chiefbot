import type { Database } from "bun:sqlite";
import { BotId, ProjectId, TaskWorkerId, TurnId, TurnKey, UserId } from "@chiefbot/contracts";
import { z } from "zod";
import { apiError, bearer } from "./http.ts";

// Who holds a turn key: the agent whose turn it is, the member the turn runs for
// (a bot's owner, the member whose coordinator turn it is, or the member who
// asked for a task worker) and the turn.
const TurnHolder = z.discriminatedUnion("agent", [
  z.object({ agent: z.literal("bot"), botId: BotId, userId: UserId, turnId: TurnId }),
  z.object({ agent: z.literal("coordinator"), projectId: ProjectId, userId: UserId, turnId: TurnId }),
  z.object({ agent: z.literal("task-worker"), workerId: TaskWorkerId, projectId: ProjectId, userId: UserId, turnId: TurnId }),
]);
export type TurnHolder = z.infer<typeof TurnHolder>;
export type BotTurn = Extract<TurnHolder, { agent: "bot" }>;
export type CoordinatorTurn = Extract<TurnHolder, { agent: "coordinator" }>;
export type TaskWorkerTurn = Extract<TurnHolder, { agent: "task-worker" }>;

// Every agent's turns that run now: a key works only while its turn is one of
// them, so a turn that ends, however it ends (done, failed, cancelled, timed out,
// its member removed, its agent deleted), revokes its key in the same write.
const liveTurns = `SELECT id FROM turns WHERE done = 0
  UNION ALL SELECT id FROM coordinator_turns WHERE state = 'running'
  UNION ALL SELECT turn_id FROM task_workers WHERE state = 'working'`;

// Turn keys (contracts ids.ts TurnKey) in control's SQLite, stored as a SHA-256.
// openStore (store.ts) calls this once every agent's turns table exists, as
// control starts: that revokes every key, so a turn still running when control
// restarted gets a new one at its runtime's hello.
export function turnKeyStore(db: Database, hash: (token: string) => string) {
  db.run("CREATE TABLE IF NOT EXISTS turn_keys (key_hash TEXT PRIMARY KEY, turn_id TEXT NOT NULL UNIQUE, holder TEXT NOT NULL)");
  db.run("DELETE FROM turn_keys");

  return {
    // A new key for the holder's running turn, which replaces any key it had.
    // The rows of keys whose turn ended go too.
    issue(holder: TurnHolder): TurnKey {
      db.run(`DELETE FROM turn_keys WHERE turn_id NOT IN (${liveTurns})`);
      const key = TurnKey.parse(crypto.randomUUID() + crypto.randomUUID());
      db.query("INSERT OR REPLACE INTO turn_keys (key_hash, turn_id, holder) VALUES (?1, ?2, ?3)").run(hash(key), holder.turnId, JSON.stringify(holder));
      return key;
    },

    // Whether the turn has no key: control restarted since it started.
    missing(turnId: TurnId): boolean {
      return db.query("SELECT 1 FROM turn_keys WHERE turn_id = ?1").get(turnId) === null;
    },

    // Who holds the key, while its turn runs; null for any other string.
    holder(key: string): TurnHolder | null {
      const row = db.query<{ holder: string }, [string]>(`SELECT holder FROM turn_keys WHERE key_hash = ?1 AND turn_id IN (${liveTurns})`).get(hash(key));
      return row ? TurnHolder.parse(JSON.parse(row.holder)) : null;
    },
  };
}

// The turn whose key is the request's bearer, if it is live and `holds` says it
// is the route's agent's; a 403 invalid_turn_key otherwise. Never anyone else's
// turn: there is no fallback.
export function heldTurn<Holder extends TurnHolder>(
  keys: ReturnType<typeof turnKeyStore>,
  req: Request,
  holds: (holder: TurnHolder) => holder is Holder,
): Holder | Response {
  const holder = keys.holder(bearer(req));
  if (holder && holds(holder)) return holder;
  return apiError(403, "invalid_turn_key", "This call needs the key of a turn of this agent that is still running.");
}

// The route's agent, for heldTurn.
export const botTurn = (botId: string) => (holder: TurnHolder): holder is BotTurn => holder.agent === "bot" && holder.botId === botId;
export const coordinatorTurn = (projectId: string) => (holder: TurnHolder): holder is CoordinatorTurn =>
  holder.agent === "coordinator" && holder.projectId === projectId;
export const taskWorkerTurn = (workerId: string) => (holder: TurnHolder): holder is TaskWorkerTurn =>
  holder.agent === "task-worker" && holder.workerId === workerId;
