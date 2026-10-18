import type { Database } from "bun:sqlite";
import { addColumn } from "../addColumn.ts";
import { Connector, ConnectorCall, UserId, type CallIdentity, type ConnectorInput, type ProjectId, type WorkspaceId } from "@chiefbot/contracts";

// Connectors, who has connected them and every call made through them, in
// control's SQLite. openStore (store.ts) calls this once the users, workspaces
// and projects tables exist. Secrets are never here: they live in the SecretStore
// (connectors.ts names them). Methods that take a name from a URL accept a plain
// string: an unknown one reads as missing.
export function connectorStore(db: Database) {
  // A workspace's connector. `server` is its ConnectorServer as JSON. has_secret:
  // the owner has put the workspace credential in the SecretStore.
  // writes_without_approval: its tools that may write run without asking.
  db.run(`CREATE TABLE IF NOT EXISTS connectors (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    server TEXT NOT NULL,
    auth TEXT NOT NULL CHECK (auth IN ('none', 'workspace-secret', 'personal-oauth')),
    scope TEXT NOT NULL,
    has_secret INTEGER NOT NULL DEFAULT 0,
    writes_without_approval INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, name)
  )`);
  // Columns added after the table first shipped.
  addColumn(db, "connectors", "writes_without_approval", "INTEGER NOT NULL DEFAULT 0");
  // A member's own connection to a personal-oauth connector: an OAuth sign-in or a pasted token.
  db.run(`CREATE TABLE IF NOT EXISTS connector_links (
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    via TEXT NOT NULL CHECK (via IN ('oauth', 'token')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, name, user_id),
    FOREIGN KEY (workspace_id, name) REFERENCES connectors (workspace_id, name) ON DELETE CASCADE
  )`);
  // The call log: one row per connector tool call of a project's agents.
  db.run(`CREATE TABLE IF NOT EXISTS connector_calls (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    connector TEXT NOT NULL,
    tool TEXT NOT NULL,
    requester TEXT NOT NULL,
    identity TEXT NOT NULL,
    run TEXT NOT NULL,
    at INTEGER NOT NULL
  )`);

  type ConnectorRow = {
    workspace_id: string;
    name: string;
    title: string;
    server: string;
    auth: string;
    scope: string;
    has_secret: number;
    writes_without_approval: number;
  };
  const toConnector = (row: ConnectorRow): Connector =>
    Connector.parse({
      workspaceId: row.workspace_id,
      name: row.name,
      title: row.title,
      server: JSON.parse(row.server),
      auth: row.auth,
      scope: row.scope,
      writesWithoutApproval: row.writes_without_approval === 1,
      hasWorkspaceSecret: row.has_secret === 1,
    });

  return {
    // A new connector, or "exists" when the workspace has one of that name.
    create(workspaceId: WorkspaceId, { name, title, server, auth, scope, writesWithoutApproval }: ConnectorInput): Connector | "exists" {
      const row = db
        .query<ConnectorRow, [string, string, string, string, string, string, number, number]>(
          `INSERT INTO connectors (workspace_id, name, title, server, auth, scope, writes_without_approval, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT DO NOTHING RETURNING *`,
        )
        .get(workspaceId, name, title, JSON.stringify(server), auth, scope, writesWithoutApproval ? 1 : 0, Date.now());
      return row ? toConnector(row) : "exists";
    },

    // The workspace's connectors, oldest first.
    list(workspaceId: WorkspaceId): Connector[] {
      return db
        .query<ConnectorRow, [string]>("SELECT * FROM connectors WHERE workspace_id = ?1 ORDER BY created_at, rowid")
        .all(workspaceId)
        .map(toConnector);
    },

    get(workspaceId: WorkspaceId, name: string): Connector | null {
      const row = db.query<ConnectorRow, [string, string]>("SELECT * FROM connectors WHERE workspace_id = ?1 AND name = ?2").get(workspaceId, name);
      return row ? toConnector(row) : null;
    },

    // Deletes the connector and its links. Resolves with the members who had
    // connected it, so the caller can delete their secrets.
    delete: db.transaction((workspaceId: WorkspaceId, name: string): UserId[] => {
      const linked = db
        .query<{ user_id: string }, [string, string]>("SELECT user_id FROM connector_links WHERE workspace_id = ?1 AND name = ?2")
        .all(workspaceId, name)
        .map((row) => UserId.parse(row.user_id));
      db.query("DELETE FROM connectors WHERE workspace_id = ?1 AND name = ?2").run(workspaceId, name);
      return linked;
    }),

    setWritesWithoutApproval(workspaceId: WorkspaceId, name: string, allowed: boolean) {
      db.query("UPDATE connectors SET writes_without_approval = ?3 WHERE workspace_id = ?1 AND name = ?2").run(workspaceId, name, allowed ? 1 : 0);
    },

    setHasSecret(workspaceId: WorkspaceId, name: string, hasSecret: boolean) {
      db.query("UPDATE connectors SET has_secret = ?3 WHERE workspace_id = ?1 AND name = ?2").run(workspaceId, name, hasSecret ? 1 : 0);
    },

    // Records that the member connected the connector.
    link(workspaceId: WorkspaceId, name: string, userId: UserId, via: "oauth" | "token") {
      db.query(
        `INSERT INTO connector_links (workspace_id, name, user_id, via, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT DO UPDATE SET via = excluded.via, created_at = excluded.created_at`,
      ).run(workspaceId, name, userId, via, Date.now());
    },

    // Names of the workspace's connectors the member has connected.
    linkedNames(workspaceId: WorkspaceId, userId: UserId): Set<string> {
      const rows = db
        .query<{ name: string }, [string, string]>("SELECT name FROM connector_links WHERE workspace_id = ?1 AND user_id = ?2")
        .all(workspaceId, userId);
      return new Set(rows.map(({ name }) => name));
    },

    logCall(projectId: ProjectId, call: { connector: string; tool: string; requester: string; identity: CallIdentity; run: string }) {
      db.query(
        "INSERT INTO connector_calls (project_id, connector, tool, requester, identity, run, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).run(projectId, call.connector, call.tool, call.requester, call.identity, call.run, Date.now());
    },

    // The project's call log, oldest first.
    calls(projectId: ProjectId): ConnectorCall[] {
      return db
        .query<ConnectorCall, [string]>(
          "SELECT connector, tool, requester, identity, run, at FROM connector_calls WHERE project_id = ?1 ORDER BY seq",
        )
        .all(projectId)
        .map((row) => ConnectorCall.parse(row));
    },
  };
}
