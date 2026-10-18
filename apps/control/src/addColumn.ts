import type { Database } from "bun:sqlite";

// Adds a column to a table that first shipped without it, in place, so existing
// databases keep working. A no-op once the column is there.
export function addColumn(db: Database, table: string, column: string, definition: string) {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!columns.some(({ name }) => name === column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
