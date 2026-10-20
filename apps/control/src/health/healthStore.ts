import type { Database } from "bun:sqlite";
import { HealthCheck, HealthItem, UserId, type ConnectionName } from "@chiefbot/contracts";
import { z } from "zod";

// The health checks of people's connections (health.ts), in control's SQLite.
// openStore (store.ts) calls this after connectionStore: a check belongs to a
// connection that is on, and goes when it is turned off.
export function healthStore(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS health_checks (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    connection TEXT NOT NULL,
    at INTEGER NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    items TEXT NOT NULL,
    FOREIGN KEY (user_id, connection) REFERENCES connections (user_id, name) ON DELETE CASCADE
  )`);
  db.run("CREATE INDEX IF NOT EXISTS health_checks_by_connection ON health_checks (user_id, connection, at)");
  const Items = z.array(HealthItem);
  type Row = { at: number; status: string; summary: string; items: string };

  return {
    record(userId: UserId, name: ConnectionName, { at, status, summary, items }: HealthCheck) {
      db.query("INSERT INTO health_checks (user_id, connection, at, status, summary, items) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(
        userId,
        name,
        at,
        status,
        summary,
        JSON.stringify(items),
      );
    },

    // The connection's checks since `since` (epoch ms), oldest first.
    checks(userId: UserId, name: ConnectionName, since: number): HealthCheck[] {
      return db
        .query<Row, [string, string, number]>("SELECT at, status, summary, items FROM health_checks WHERE user_id = ?1 AND connection = ?2 AND at >= ?3 ORDER BY at, seq")
        .all(userId, name, since)
        .map(({ items, ...row }) => HealthCheck.parse({ ...row, items: Items.parse(JSON.parse(items)) }));
    },

    // Every person's connection among `names` that is on and has no check after `since`.
    due(names: ConnectionName[], since: number): Array<{ userId: UserId; name: ConnectionName }> {
      if (names.length === 0) return [];
      return db
        .query<{ user_id: string; name: string }, [string, number]>(
          `SELECT connections.user_id, connections.name FROM connections
           WHERE connections.name IN (SELECT value FROM json_each(?1))
           AND NOT EXISTS (SELECT 1 FROM health_checks WHERE health_checks.user_id = connections.user_id
             AND health_checks.connection = connections.name AND health_checks.at > ?2)`,
        )
        .all(JSON.stringify(names), since)
        .map(({ user_id, name }) => ({ userId: UserId.parse(user_id), name }));
    },

    // Deletes every check older than `before`.
    prune(before: number) {
      db.query("DELETE FROM health_checks WHERE at < ?1").run(before);
    },
  };
}
