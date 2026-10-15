import { Database } from "bun:sqlite";
import { CopilotPlan, UserId, type GitHubTokens, type SessionToken, type User } from "@chiefbot/contracts";
import type { GitHubIdentity } from "./github.ts";

// Control's durable state in SQLite. Every row hangs off a user.
export function openStore(path: string) {
  const db = new Database(path, { strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    github_id INTEGER NOT NULL UNIQUE,
    login TEXT NOT NULL,
    copilot_plan TEXT
  )`);
  // The refresh token lives only here; no endpoint returns it.
  db.run(`CREATE TABLE IF NOT EXISTS github_tokens (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    access_token_expires_at INTEGER NOT NULL,
    refresh_token TEXT NOT NULL,
    refresh_token_expires_at INTEGER NOT NULL
  )`);
  // Sessions are stored as a SHA-256 of the bearer token.
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  )`);

  const toUser = (row: { id: string; login: string; copilot_plan: string | null }): User => ({
    id: UserId.parse(row.id),
    login: row.login,
    copilotPlan: CopilotPlan.parse(row.copilot_plan === null ? null : JSON.parse(row.copilot_plan)),
  });

  return {
    // Creates or updates the user GitHub identified, replaces their GitHub tokens
    // and opens a session. One transaction, so a sign-in lands whole or not at all.
    signIn: db.transaction((identity: GitHubIdentity, tokens: GitHubTokens, sessionToken: SessionToken): User => {
      const row = db
        .query<{ id: string; login: string; copilot_plan: string | null }, [string, number, string, string]>(
          `INSERT INTO users (id, github_id, login, copilot_plan) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, copilot_plan = excluded.copilot_plan
           RETURNING id, login, copilot_plan`,
        )
        .get(`user_${crypto.randomUUID()}`, identity.githubId, identity.login, JSON.stringify(identity.copilotPlan));
      if (!row) throw new Error("user upsert returned no row");
      db.query(
        `INSERT OR REPLACE INTO github_tokens
         (user_id, access_token, access_token_expires_at, refresh_token, refresh_token_expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).run(row.id, tokens.accessToken, tokens.accessTokenExpiresAt, tokens.refreshToken, tokens.refreshTokenExpiresAt);
      db.query("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?1, ?2, ?3)").run(
        hash(sessionToken),
        row.id,
        Date.now(),
      );
      return toUser(row);
    }),

    userForSession(sessionToken: string): User | null {
      const row = db
        .query<{ id: string; login: string; copilot_plan: string | null }, [string]>(
          `SELECT users.id, users.login, users.copilot_plan FROM sessions
           JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?1`,
        )
        .get(hash(sessionToken));
      return row ? toUser(row) : null;
    },

    endSession(sessionToken: string) {
      db.query("DELETE FROM sessions WHERE token_hash = ?1").run(hash(sessionToken));
    },

    close: () => db.close(),
  };
}

function hash(sessionToken: string) {
  return new Bun.CryptoHasher("sha256").update(sessionToken).digest("hex");
}
