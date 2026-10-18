import type { Database } from "bun:sqlite";
import { addColumn } from "./addColumn.ts";
import {
  CopilotMode,
  UserId,
  Workspace,
  WorkspaceId,
  WorkspaceInvite,
  WorkspaceRole,
  type User,
  type WorkspaceMember,
} from "@chiefbot/contracts";

// Workspaces (teams), their members and pending invites, in control's SQLite.
// openStore (store.ts) calls this once the users table exists. Methods that take
// an id from a URL accept a plain string: an unknown one reads as missing.
export function workspaceStore(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // copilot_mode: who pays for the Copilot requests of the workspace's project
  // agents (CopilotMode). Added after the table first shipped.
  addColumn(db, "workspaces", "copilot_mode", "TEXT NOT NULL DEFAULT 'personal'");
  db.run(`CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  )`);
  // An invite waits for a user with `login` (GitHub logins match case-insensitively)
  // to sign in and accept it. Accepting deletes it and adds the member.
  db.run(`CREATE TABLE IF NOT EXISTS workspace_invites (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    login TEXT NOT NULL COLLATE NOCASE,
    invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, login)
  )`);

  type WorkspaceRow = { id: string; name: string; role: string; copilot_mode: string };
  const toWorkspace = ({ copilot_mode, ...row }: WorkspaceRow): Workspace => Workspace.parse({ ...row, copilotMode: copilot_mode });
  const workspaceColumns = `workspaces.id, workspaces.name, workspace_members.role, workspaces.copilot_mode
    FROM workspaces JOIN workspace_members ON workspace_members.workspace_id = workspaces.id`;

  // The workspace as the user sees it, or null when they are not a member
  // (or it does not exist): every workspace route checks this first.
  const workspaceFor = (userId: UserId, workspaceId: string): Workspace | null => {
    const row = db
      .query<WorkspaceRow, [string, string]>(`SELECT ${workspaceColumns} WHERE workspace_members.user_id = ?1 AND workspaces.id = ?2`)
      .get(userId, workspaceId);
    return row ? toWorkspace(row) : null;
  };

  type InviteRow = { id: string; workspace_id: string; workspace_name: string; login: string; invited_by: string };
  const toInvite = (row: InviteRow): WorkspaceInvite =>
    WorkspaceInvite.parse({
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      login: row.login,
      invitedBy: row.invited_by,
    });
  const inviteColumns = `workspace_invites.id, workspace_id, workspaces.name AS workspace_name, workspace_invites.login,
    users.login AS invited_by FROM workspace_invites JOIN workspaces ON workspaces.id = workspace_id
    JOIN users ON users.id = invited_by`;

  return {
    // A new workspace with `userId` as its owner.
    create: db.transaction((userId: UserId, name: string): Workspace => {
      const id = WorkspaceId.parse(`workspace_${crypto.randomUUID()}`);
      const now = Date.now();
      db.query("INSERT INTO workspaces (id, name, created_at) VALUES (?1, ?2, ?3)").run(id, name, now);
      db.query("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)").run(
        id,
        userId,
        now,
      );
      return { id, name, role: "owner", copilotMode: "personal" };
    }),

    // Who pays for the Copilot requests of the workspace's project agents.
    setCopilotMode(workspaceId: WorkspaceId, mode: CopilotMode) {
      db.query("UPDATE workspaces SET copilot_mode = ?2 WHERE id = ?1").run(workspaceId, mode);
    },

    // The workspace's mode, or null when there is no such workspace.
    copilotMode(workspaceId: WorkspaceId): CopilotMode | null {
      const row = db.query<{ copilot_mode: string }, [string]>("SELECT copilot_mode FROM workspaces WHERE id = ?1").get(workspaceId);
      return row ? CopilotMode.parse(row.copilot_mode) : null;
    },

    // The workspaces the user is a member of, with their role in each.
    workspacesFor(userId: UserId): Workspace[] {
      return db
        .query<WorkspaceRow, [string]>(
          `SELECT ${workspaceColumns} WHERE workspace_members.user_id = ?1 ORDER BY workspaces.created_at, workspaces.id`,
        )
        .all(userId)
        .map(toWorkspace);
    },

    workspaceFor,

    // Owner first, then members in the order they joined.
    members(workspaceId: WorkspaceId): WorkspaceMember[] {
      return db
        .query<{ user_id: string; login: string; role: string }, [string]>(
          `SELECT user_id, users.login, role FROM workspace_members JOIN users ON users.id = workspace_members.user_id
           WHERE workspace_id = ?1 ORDER BY role = 'member', joined_at, user_id`,
        )
        .all(workspaceId)
        .map((row) => ({ userId: UserId.parse(row.user_id), login: row.login, role: WorkspaceRole.parse(row.role) }));
    },

    // Removes a member (never the owner). False when the user is no such member.
    removeMember(workspaceId: WorkspaceId, userId: string) {
      return (
        db.query("DELETE FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2 AND role = 'member'").run(workspaceId, userId)
          .changes > 0
      );
    },

    // Invites `login` to the workspace. Inviting a login again returns its
    // pending invite; "already_member" when a member has that login.
    invite: db.transaction((workspaceId: WorkspaceId, login: string, invitedBy: UserId): WorkspaceInvite | "already_member" => {
      const member = db
        .query(
          `SELECT 1 FROM workspace_members JOIN users ON users.id = user_id
           WHERE workspace_id = ?1 AND users.login = ?2 COLLATE NOCASE`,
        )
        .get(workspaceId, login);
      if (member) return "already_member";
      db.query(
        `INSERT INTO workspace_invites (id, workspace_id, login, invited_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (workspace_id, login) DO NOTHING`,
      ).run(`invite_${crypto.randomUUID()}`, workspaceId, login, invitedBy, Date.now());
      const row = db
        .query<InviteRow, [string, string]>(`SELECT ${inviteColumns} WHERE workspace_id = ?1 AND workspace_invites.login = ?2`)
        .get(workspaceId, login);
      if (!row) throw new Error("invite upsert left no row");
      return toInvite(row);
    }),

    // False when the workspace has no such pending invite.
    revokeInvite(workspaceId: WorkspaceId, inviteId: string) {
      return db.query("DELETE FROM workspace_invites WHERE id = ?1 AND workspace_id = ?2").run(inviteId, workspaceId).changes > 0;
    },

    // The workspace's pending invites, oldest first.
    invites(workspaceId: WorkspaceId): WorkspaceInvite[] {
      return db
        .query<InviteRow, [string]>(`SELECT ${inviteColumns} WHERE workspace_id = ?1 ORDER BY workspace_invites.created_at, workspace_invites.id`)
        .all(workspaceId)
        .map(toInvite);
    },

    // The pending invites for a GitHub login, oldest first.
    invitesForLogin(login: string): WorkspaceInvite[] {
      return db
        .query<InviteRow, [string]>(
          `SELECT ${inviteColumns} WHERE workspace_invites.login = ?1 ORDER BY workspace_invites.created_at, workspace_invites.id`,
        )
        .all(login)
        .map(toInvite);
    },

    // Makes the user a member through an invite for their login. Null, changing
    // nothing, when no such invite is for them.
    accept: db.transaction((user: User, inviteId: string): Workspace | null => {
      const invite = db
        .query<{ workspace_id: string }, [string, string]>(
          "DELETE FROM workspace_invites WHERE id = ?1 AND login = ?2 RETURNING workspace_id",
        )
        .get(inviteId, user.login);
      if (!invite) return null;
      db.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?1, ?2, 'member', ?3) ON CONFLICT DO NOTHING",
      ).run(invite.workspace_id, user.id, Date.now());
      return workspaceFor(user.id, invite.workspace_id);
    }),
  };
}
