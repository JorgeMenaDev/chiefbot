import type { Database } from "bun:sqlite";
import { QuestionForm, QuestionId, QuestionResult, TurnId, type BotId } from "@chiefbot/contracts";

// The questions bots asked their owners (Copilot's ask_user forms, contracts
// questions.ts), in control's SQLite, kept apart from approvals. openStore
// (store.ts) calls this once the bots and turns tables exist.
export function questionStore(db: Database) {
  // One question form a bot asked in one of its turns, and when (epoch
  // milliseconds). `status` is pending until the owner answers (`answer` holds
  // the QuestionResult as JSON) or the agent stops waiting (withdrawn). The
  // request itself is in chat_events too.
  db.run(`CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    form TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    answer TEXT
  )`);
  // Only a pending question of a turn still running can be answered: one whose turn ended never can.
  const answerable = "status = 'pending' AND turn_id IN (SELECT id FROM turns WHERE done = 0)";

  return {
    record(botId: BotId, turnId: TurnId, questionId: QuestionId, form: QuestionForm, at: number) {
      db.query("INSERT INTO questions (id, bot_id, turn_id, form, requested_at) VALUES (?1, ?2, ?3, ?4, ?5)").run(
        questionId,
        botId,
        turnId,
        JSON.stringify(form),
        at,
      );
    },

    // The form of the bot's question while it can be answered; null otherwise.
    answerableForm(botId: BotId, questionId: string): QuestionForm | null {
      const row = db.query<{ form: string }, [string, string]>(`SELECT form FROM questions WHERE id = ?1 AND bot_id = ?2 AND ${answerable}`).get(questionId, botId);
      return row ? QuestionForm.parse(JSON.parse(row.form)) : null;
    },

    // Records the answer to the bot's question while it can be answered. Its
    // turn, or null, storing nothing, when it cannot.
    answer(botId: BotId, questionId: QuestionId, result: QuestionResult): TurnId | null {
      const row = db
        .query<{ turn_id: string }, [string, string, string]>(
          `UPDATE questions SET status = 'answered', answer = ?3 WHERE id = ?1 AND bot_id = ?2 AND ${answerable} RETURNING turn_id`,
        )
        .get(questionId, botId, JSON.stringify(result));
      return row ? TurnId.parse(row.turn_id) : null;
    },

    // The bot's agent no longer waits on the question, if it was pending.
    withdraw(botId: BotId, questionId: QuestionId) {
      db.query("UPDATE questions SET status = 'withdrawn' WHERE id = ?1 AND bot_id = ?2 AND status = 'pending'").run(questionId, botId);
    },

    // Withdraws every pending question of one of the bot's turns, and returns their ids.
    withdrawTurn(botId: BotId, turnId: TurnId): QuestionId[] {
      return db
        .query<{ id: string }, [string, string]>("UPDATE questions SET status = 'withdrawn' WHERE bot_id = ?1 AND turn_id = ?2 AND status = 'pending' RETURNING id")
        .all(botId, turnId)
        .map((row) => QuestionId.parse(row.id));
    },

    // The answered questions of one of the bot's turns, for a worker that may have missed the answers.
    answered(botId: BotId, turnId: TurnId) {
      return db
        .query<{ id: string; answer: string }, [string, string]>("SELECT id, answer FROM questions WHERE bot_id = ?1 AND turn_id = ?2 AND status = 'answered'")
        .all(botId, turnId)
        .map((row) => ({ questionId: QuestionId.parse(row.id), result: QuestionResult.parse(JSON.parse(row.answer)) }));
    },
  };
}
