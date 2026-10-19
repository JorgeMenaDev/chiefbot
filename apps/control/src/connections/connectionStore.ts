import type { Database } from "bun:sqlite";
import { ConnectionCall, type BotId, type ReportedConnectionCall, type TurnId, type UserId } from "@chiefbot/contracts";
import { z } from "zod";

// Who has which connection on, and the log of the commands their bots ran with
// them, in control's SQLite. openStore (store.ts) calls this once the users and
// bots tables exist. Secret fields are never here: they live in the SecretStore
// (connections.ts names them).
export function connectionStore(db: Database) {
  // A person's connection that is on: its plain fields as JSON.
  db.run(`CREATE TABLE IF NOT EXISTS connections (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    fields TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, name)
  )`);
  // The call log: one row per command of a connection's CLI a bot ran.
  db.run(`CREATE TABLE IF NOT EXISTS connection_calls (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    connection TEXT NOT NULL,
    command TEXT NOT NULL,
    run TEXT NOT NULL,
    at INTEGER NOT NULL
  )`);
  const Fields = z.record(z.string(), z.string());

  return {
    // Turns the connection on with these plain fields, or replaces them.
    save(userId: UserId, name: string, fields: Record<string, string>) {
      db.query(
        `INSERT INTO connections (user_id, name, fields, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT DO UPDATE SET fields = excluded.fields`,
      ).run(userId, name, JSON.stringify(fields), Date.now());
    },

    remove(userId: UserId, name: string) {
      db.query("DELETE FROM connections WHERE user_id = ?1 AND name = ?2").run(userId, name);
    },

    // The person's connections that are on, by name, with their plain fields.
    on(userId: UserId): Map<string, Record<string, string>> {
      const rows = db.query<{ name: string; fields: string }, [string]>("SELECT name, fields FROM connections WHERE user_id = ?1").all(userId);
      return new Map(rows.map(({ name, fields }) => [name, Fields.parse(JSON.parse(fields))]));
    },

    logCall(botId: BotId, turnId: TurnId, { connection, command }: ReportedConnectionCall) {
      db.query("INSERT INTO connection_calls (bot_id, connection, command, run, at) VALUES (?1, ?2, ?3, ?4, ?5)").run(
        botId,
        connection,
        command,
        turnId,
        Date.now(),
      );
    },

    // The bot's call log, oldest first.
    calls(botId: BotId): ConnectionCall[] {
      return db
        .query<ConnectionCall, [string]>("SELECT connection, command, run, at FROM connection_calls WHERE bot_id = ?1 ORDER BY seq")
        .all(botId)
        .map((row) => ConnectionCall.parse(row));
    },
  };
}
