import { Database } from "bun:sqlite";
import {
  BotId,
  AUTO_MODEL,
  ChatEvent,
  CopilotPlan,
  ModelReport,
  TurnId,
  UserId,
  type BotToken,
  type TurnEvent,
  type GitHubTokens,
  type SessionToken,
  type User,
} from "@chiefbot/contracts";
import type { GitHubIdentity } from "./github.ts";

// Control's durable state in SQLite. Every row hangs off a user.
export function openStore(path: string) {
  const db = new Database(path, { strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  // Deleted rows are overwritten, so a dropped or deleted token leaves no plain text behind.
  db.run("PRAGMA secure_delete = ON");
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    github_id INTEGER NOT NULL UNIQUE,
    login TEXT NOT NULL,
    copilot_plan TEXT
  )`);
  // github_tokens held refresh tokens in plain text before ticket #8. Dropping it
  // signs everyone out of GitHub once; the checkpoint writes the zeroed pages to the file.
  if (db.query("SELECT 1 FROM sqlite_master WHERE name = 'github_tokens'").get()) {
    db.run("DROP TABLE github_tokens");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  // A user's GitHub sign-in as the token broker (tokens.ts) keeps it: the
  // short-lived access token and both expiry times. The refresh token is in the
  // SecretStore. No row means the user must sign in again.
  db.run(`CREATE TABLE IF NOT EXISTS github_access (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    access_token_expires_at INTEGER NOT NULL,
    refresh_token_expires_at INTEGER NOT NULL
  )`);
  // Sessions are stored as a SHA-256 of the bearer token.
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  )`);
  // A bot's worker credential is stored as a SHA-256 too. `running` is the state
  // control wants the bot's computer in; online-ness lives in memory.
  db.run(`CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    running INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  // A bot's chat: turns (one user message and the bot's work on it) and every
  // event of them in order. A turn is done once its `done` event is stored.
  // next_index is the number of the worker's next event for the turn.
  db.run(`CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    done INTEGER NOT NULL,
    next_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS chat_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    event TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS chat_events_by_bot ON chat_events (bot_id, seq)");

  // Columns added after the tables first shipped, added in place so existing databases keep working.
  const addColumn = (table: string, column: string, definition: string) => {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!columns.some(({ name }) => name === column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  // The bot's Copilot model id.
  addColumn("bots", "model", `TEXT NOT NULL DEFAULT '${AUTO_MODEL}'`);
  // The latest ModelReport (JSON) a worker of the user's bots sent: control's cache of their plan's models.
  addColumn("users", "copilot_models", "TEXT");

  type BotRow = { id: string; name: string; running: number; model: string };
  const toBotRecord = (row: BotRow) => ({
    id: BotId.parse(row.id),
    name: row.name,
    running: row.running === 1,
    model: row.model,
  });

  type UserRow = { id: string; login: string; copilot_plan: string | null; needs_sign_in: number };
  const toUser = (row: UserRow): User => ({
    id: UserId.parse(row.id),
    login: row.login,
    copilotPlan: CopilotPlan.parse(row.copilot_plan === null ? null : JSON.parse(row.copilot_plan)),
    needsGitHubSignIn: row.needs_sign_in === 1,
  });
  const userColumns = `users.id, users.login, users.copilot_plan, github_access.user_id IS NULL AS needs_sign_in
    FROM users LEFT JOIN github_access ON github_access.user_id = users.id`;
  const userById = (userId: UserId) => {
    const row = db.query<UserRow, [string]>(`SELECT ${userColumns} WHERE users.id = ?1`).get(userId);
    if (!row) throw new Error(`no user ${userId}`);
    return toUser(row);
  };

  type ChatEventRow = { seq: number; turn_id: string; event: string };
  const toChatEvent = (row: ChatEventRow) =>
    ChatEvent.parse({ seq: row.seq, turnId: row.turn_id, event: JSON.parse(row.event) });
  const append = (botId: BotId, turnId: TurnId, event: ChatEvent["event"]) => {
    const row = db
      .query<ChatEventRow, [string, string, string]>(
        "INSERT INTO chat_events (bot_id, turn_id, event) VALUES (?1, ?2, ?3) RETURNING seq, turn_id, event",
      )
      .get(botId, turnId, JSON.stringify(event));
    if (!row) throw new Error("chat event insert returned no row");
    return toChatEvent(row);
  };

  return {
    // Creates or updates the user GitHub identified.
    upsertUser(identity: GitHubIdentity): UserId {
      const row = db
        .query<{ id: string }, [string, number, string, string]>(
          `INSERT INTO users (id, github_id, login, copilot_plan) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, copilot_plan = excluded.copilot_plan
           RETURNING id`,
        )
        .get(`user_${crypto.randomUUID()}`, identity.githubId, identity.login, JSON.stringify(identity.copilotPlan));
      if (!row) throw new Error("user upsert returned no row");
      return UserId.parse(row.id);
    },

    user: userById,

    openSession(userId: UserId, sessionToken: SessionToken) {
      db.query("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?1, ?2, ?3)").run(
        hash(sessionToken),
        userId,
        Date.now(),
      );
    },

    // The token broker's rows. Only tokens.ts calls these.
    githubAccess(userId: UserId) {
      const row = db
        .query<{ access_token: string; access_token_expires_at: number; refresh_token_expires_at: number }, [string]>(
          "SELECT access_token, access_token_expires_at, refresh_token_expires_at FROM github_access WHERE user_id = ?1",
        )
        .get(userId);
      return row
        ? {
            accessToken: row.access_token,
            accessTokenExpiresAt: row.access_token_expires_at,
            refreshTokenExpiresAt: row.refresh_token_expires_at,
          }
        : null;
    },
    setGitHubAccess(userId: UserId, tokens: Omit<GitHubTokens, "refreshToken">) {
      db.query(
        `INSERT OR REPLACE INTO github_access (user_id, access_token, access_token_expires_at, refresh_token_expires_at)
         VALUES (?1, ?2, ?3, ?4)`,
      ).run(userId, tokens.accessToken, tokens.accessTokenExpiresAt, tokens.refreshTokenExpiresAt);
    },
    deleteGitHubAccess(userId: UserId) {
      db.query("DELETE FROM github_access WHERE user_id = ?1").run(userId);
    },

    userForSession(sessionToken: string): User | null {
      const row = db
        .query<UserRow, [string]>(
          `SELECT ${userColumns} JOIN sessions ON sessions.user_id = users.id WHERE sessions.token_hash = ?1`,
        )
        .get(hash(sessionToken));
      return row ? toUser(row) : null;
    },

    endSession(sessionToken: string) {
      db.query("DELETE FROM sessions WHERE token_hash = ?1").run(hash(sessionToken));
    },

    // A new bot whose computer should run.
    createBot(userId: UserId, name: string, botToken: BotToken) {
      const row = db
        .query<BotRow, [string, string, string, string, number]>(
          `INSERT INTO bots (id, user_id, name, token_hash, running, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)
           RETURNING id, name, running, model`,
        )
        .get(`bot_${crypto.randomUUID()}`, userId, name, hash(botToken), Date.now());
      if (!row) throw new Error("bot insert returned no row");
      return toBotRecord(row);
    },

    botsFor(userId: UserId) {
      return db
        .query<BotRow, [string]>("SELECT id, name, running, model FROM bots WHERE user_id = ?1 ORDER BY created_at, id")
        .all(userId)
        .map(toBotRecord);
    },

    // Only the owner's bot: another user's bot id reads as missing.
    botFor(userId: UserId, botId: string) {
      const row = db
        .query<BotRow, [string, string]>("SELECT id, name, running, model FROM bots WHERE user_id = ?1 AND id = ?2")
        .get(userId, botId);
      return row ? toBotRecord(row) : null;
    },

    // The bot a worker credential belongs to, and its owner.
    botForToken(botToken: string) {
      const row = db
        .query<{ id: string; user_id: string }, [string]>("SELECT id, user_id FROM bots WHERE token_hash = ?1")
        .get(hash(botToken));
      return row ? { botId: BotId.parse(row.id), userId: UserId.parse(row.user_id) } : null;
    },

    setRunning(botId: BotId, running: boolean) {
      db.query("UPDATE bots SET running = ?2 WHERE id = ?1").run(botId, running ? 1 : 0);
    },

    setBotModel(botId: BotId, model: string) {
      db.query("UPDATE bots SET model = ?2 WHERE id = ?1").run(botId, model);
    },

    setModelReport(userId: UserId, report: ModelReport) {
      db.query("UPDATE users SET copilot_models = ?2 WHERE id = ?1").run(userId, JSON.stringify(report));
    },

    // Null until a worker of the user's bots has listed their plan's models.
    modelReport(userId: UserId): ModelReport | null {
      const row = db.query<{ copilot_models: string | null }, [string]>("SELECT copilot_models FROM users WHERE id = ?1").get(userId);
      return row?.copilot_models ? ModelReport.parse(JSON.parse(row.copilot_models)) : null;
    },

    deleteBot(botId: BotId) {
      db.query("DELETE FROM bots WHERE id = ?1").run(botId);
    },

    // Opens a turn with the user's message.
    startTurn: db.transaction((botId: BotId, text: string): ChatEvent => {
      const turnId = TurnId.parse(`turn_${crypto.randomUUID()}`);
      db.query("INSERT INTO turns (id, bot_id, done, created_at) VALUES (?1, ?2, 0, ?3)").run(turnId, botId, Date.now());
      return append(botId, turnId, { type: "user-message", text });
    }),

    // Adds the worker's event number `index` to the bot's unfinished turn; `done`
    // finishes it. Null, storing nothing, for a repeat or another bot's or a done turn.
    appendTurnEvent: db.transaction((botId: BotId, turnId: TurnId, index: number, event: TurnEvent): ChatEvent | null => {
      const updated = db
        .query(
          `UPDATE turns SET next_index = next_index + 1, done = ?4
           WHERE id = ?1 AND bot_id = ?2 AND done = 0 AND next_index = ?3 RETURNING id`,
        )
        .get(turnId, botId, index, event.type === "done" ? 1 : 0);
      return updated ? append(botId, turnId, event) : null;
    }),

    // Ends an unfinished turn from control's side (its worker lost it).
    abandonTurn: db.transaction((botId: BotId, turnId: TurnId, message: string): ChatEvent[] => {
      const updated = db.query("UPDATE turns SET done = 1 WHERE id = ?1 AND bot_id = ?2 AND done = 0 RETURNING id").get(turnId, botId);
      if (!updated) return [];
      return [append(botId, turnId, { type: "error", message }), append(botId, turnId, { type: "done" })];
    }),

    unfinishedTurns(botId: BotId): TurnId[] {
      return db
        .query<{ id: string }, [string]>("SELECT id FROM turns WHERE bot_id = ?1 AND done = 0 ORDER BY created_at")
        .all(botId)
        .map((row) => TurnId.parse(row.id));
    },

    // The bot's chat history after `seq` (0 for all of it), oldest first.
    chatAfter(botId: BotId, seq: number): ChatEvent[] {
      return db
        .query<ChatEventRow, [string, number]>(
          "SELECT seq, turn_id, event FROM chat_events WHERE bot_id = ?1 AND seq > ?2 ORDER BY seq",
        )
        .all(botId, seq)
        .map(toChatEvent);
    },

    close: () => db.close(),
  };
}

function hash(token: string) {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}
