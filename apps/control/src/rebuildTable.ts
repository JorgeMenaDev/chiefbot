import type { Database } from "bun:sqlite";

// Makes a table that first shipped with a definition SQLite cannot change in
// place (a CHECK) again from `create`, its CREATE TABLE IF NOT EXISTS statement,
// when its stored definition lacks `marker`. Each row keeps the columns the old
// table had; a new column takes its default. Foreign keys are off meanwhile, so
// dropping the old table cascades to no row that references it. A no-op once the
// table has the definition, or does not exist yet.
export function rebuildTable(db: Database, table: string, create: string, marker: string) {
  const stored = db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table);
  if (!stored || stored.sql.includes(marker)) return;
  const prefix = `CREATE TABLE IF NOT EXISTS ${table} (`;
  if (!create.startsWith(prefix)) throw new Error(`rebuildTable expects ${prefix}…`);
  const columns = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map(({ name }) => name)
    .join(", ");
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.run(`CREATE TABLE ${table}_rebuilt (${create.slice(prefix.length)}`);
      db.run(`INSERT INTO ${table}_rebuilt (${columns}) SELECT ${columns} FROM ${table}`);
      db.run(`DROP TABLE ${table}`);
      db.run(`ALTER TABLE ${table}_rebuilt RENAME TO ${table}`);
    })();
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}
