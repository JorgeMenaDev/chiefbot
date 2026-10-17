import type { Database } from "bun:sqlite";
import { ApprovalId, ApprovalKind, ChatEvent, TurnId } from "@chiefbot/contracts";

// What every agent's turns share in control's SQLite: a bot's chat (store.ts), a
// member's chat with a coordinator (projectStore.ts) and a task worker's
// transcript (taskWorkerStore.ts) store events the same way, number the
// runtime's events the same way, and keep approvals the same way.

// A stored chat event row: its sequence number, its turn and the event as JSON.
export type ChatEventRow = { seq: number; turn_id: string; event: string };
export const toChatEvent = (row: ChatEventRow) => ChatEvent.parse({ seq: row.seq, turnId: row.turn_id, event: JSON.parse(row.event) });

// An agent's runtime numbers each event of a turn (0, 1, 2…) and resends them
// after a reconnect; control stores each once. This counts event `index` of the
// turn that `running` (SQL over ?1 and ?2, from `keys`) picks in `table`, when
// it is that turn's next: true once, false for a repeat, a gap or a turn that
// does not run.
export function acceptEvent(db: Database, table: string, running: string, keys: [string, string], index: number) {
  return db.query(`UPDATE ${table} SET next_index = next_index + 1 WHERE ${running} AND next_index = ?3 RETURNING 1`).get(...keys, index) !== null;
}

type Ask = { approvalId: ApprovalId; kind: ApprovalKind; detail: string };

// One agent kind's approvals in `table`: what its runtime or control asked in one
// of its owner's turns (the owner is a bot, a task worker or a project, in the
// `owner` column), when (epoch milliseconds), and the answer (approved NULL
// while pending). Only a turn `liveTurns` lists (SQL selecting turn ids) can be
// answered: one that ended can never be.
export function approvalRecords(db: Database, { table, owner, liveTurns }: { table: string; owner: string; liveTurns: string }) {
  const live = `turn_id IN (${liveTurns})`;
  return {
    record(ownerId: string, turnId: TurnId, { approvalId, kind, detail }: Ask, at: number) {
      db.query(`INSERT INTO ${table} (id, ${owner}, turn_id, kind, detail, requested_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).run(
        approvalId,
        ownerId,
        turnId,
        kind,
        detail,
        at,
      );
    },

    // The turn of the owner's pending approval while that turn runs; null otherwise.
    pendingTurn(ownerId: string, approvalId: string): TurnId | null {
      const row = db
        .query<{ turn_id: string }, [string, string]>(`SELECT turn_id FROM ${table} WHERE id = ?1 AND ${owner} = ?2 AND approved IS NULL AND ${live}`)
        .get(approvalId, ownerId);
      return row ? TurnId.parse(row.turn_id) : null;
    },

    // Records the answer to the owner's pending approval of a running turn. Its
    // id and turn, or null, storing nothing, when there is no such approval.
    answer(ownerId: string, approvalId: string, approved: boolean): { approvalId: ApprovalId; turnId: TurnId } | null {
      const row = db
        .query<{ id: string; turn_id: string }, [string, string, number]>(
          `UPDATE ${table} SET approved = ?3 WHERE id = ?1 AND ${owner} = ?2 AND approved IS NULL AND ${live} RETURNING id, turn_id`,
        )
        .get(approvalId, ownerId, approved ? 1 : 0);
      return row ? { approvalId: ApprovalId.parse(row.id), turnId: TurnId.parse(row.turn_id) } : null;
    },

    // The owner's agent no longer waits on the pending approval: it is no longer
    // pending, and can no longer be answered. False when it was not pending.
    withdraw(ownerId: string, approvalId: ApprovalId): boolean {
      return db.query(`DELETE FROM ${table} WHERE id = ?1 AND ${owner} = ?2 AND approved IS NULL RETURNING id`).get(approvalId, ownerId) !== null;
    },

    // What the owner's running turns wait on, oldest first.
    pending(ownerId: string): Ask[] {
      return db
        .query<{ id: string; kind: string; detail: string }, [string]>(
          `SELECT id, kind, detail FROM ${table} WHERE ${owner} = ?1 AND approved IS NULL AND ${live} ORDER BY rowid`,
        )
        .all(ownerId)
        .map((row) => ({ approvalId: ApprovalId.parse(row.id), kind: ApprovalKind.parse(row.kind), detail: row.detail }));
    },

    // The answered approvals of one of the owner's turns, for a runtime that may have missed the answers.
    answered(ownerId: string, turnId: TurnId) {
      return db
        .query<{ id: string; approved: number }, [string, string]>(
          `SELECT id, approved FROM ${table} WHERE ${owner} = ?1 AND turn_id = ?2 AND approved IS NOT NULL`,
        )
        .all(ownerId, turnId)
        .map((row) => ({ approvalId: ApprovalId.parse(row.id), approved: row.approved === 1 }));
    },

    // Every pending approval of a running turn, of any owner, with when it was asked.
    waiting(): Array<{ ownerId: string; approvalId: ApprovalId; requestedAt: number }> {
      return db
        .query<{ owner: string; id: string; requested_at: number }, []>(
          `SELECT ${owner} AS owner, id, requested_at FROM ${table} WHERE approved IS NULL AND ${live}`,
        )
        .all()
        .map((row) => ({ ownerId: row.owner, approvalId: ApprovalId.parse(row.id), requestedAt: row.requested_at }));
    },
  };
}
