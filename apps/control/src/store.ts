import { Database } from "bun:sqlite";
import {
  BotId,
  ChatEvent,
  CopilotPlan,
  Routine,
  RoutineId,
  TurnId,
  UserId,
  type BotToken,
  type BrokeredGitHubToken,
  type TurnEvent,
  type GitHubTokens,
  type RoutineInput,
  type RoutineRun,
  type SessionToken,
  type User,
} from "@chiefbot/contracts";
import type { GitHubIdentity } from "./github.ts";
import { nextDueAt } from "./schedule.ts";

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

  // A bot's routines: a prompt run on a cron schedule. next_due_at is the next
  // time it runs, epoch milliseconds.
  db.run(`CREATE TABLE IF NOT EXISTS routines (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    next_due_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // One row per (routine, due time), inserted when the scheduler claims that due
  // time. The primary key is what makes a run happen at most once, across restarts.
  // started_computer: the run started a stopped computer and must stop it again.
  db.run(`CREATE TABLE IF NOT EXISTS routine_runs (
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    turn_id TEXT,
    error TEXT,
    started_computer INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (routine_id, due_at)
  )`);

  type BotRow = { id: string; name: string; running: number };
  const toBotRecord = (row: BotRow) => ({ id: BotId.parse(row.id), name: row.name, running: row.running === 1 });

  const toUser = (row: { id: string; login: string; copilot_plan: string | null }): User => ({
    id: UserId.parse(row.id),
    login: row.login,
    copilotPlan: CopilotPlan.parse(row.copilot_plan === null ? null : JSON.parse(row.copilot_plan)),
  });

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

  type RoutineRow = { id: string; bot_id: string; prompt: string; cron: string; timezone: string; next_due_at: number };
  type RunRow = { due_at: number; status: string; turn_id: string | null; error: string | null };
  const lastRun = (routineId: string) =>
    db
      .query<RunRow, [string]>(
        "SELECT due_at, status, turn_id, error FROM routine_runs WHERE routine_id = ?1 ORDER BY due_at DESC LIMIT 1",
      )
      .get(routineId);
  const toRoutine = (row: RoutineRow): Routine => {
    const run = lastRun(row.id);
    return Routine.parse({
      id: row.id,
      botId: row.bot_id,
      prompt: row.prompt,
      cron: row.cron,
      timezone: row.timezone,
      nextDueAt: row.next_due_at,
      lastRun: run && { dueAt: run.due_at, status: run.status, turnId: run.turn_id, error: run.error },
    });
  };
  const routineColumns = "id, bot_id, prompt, cron, timezone, next_due_at";
  // A claimed run: what the scheduler needs to carry it out.
  type RunRef = { routineId: RoutineId; dueAt: number; botId: BotId; userId: UserId };
  const toRunRef = (row: { routine_id: string; due_at: number; bot_id: string; user_id: string }): RunRef => ({
    routineId: RoutineId.parse(row.routine_id),
    dueAt: row.due_at,
    botId: BotId.parse(row.bot_id),
    userId: UserId.parse(row.user_id),
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

    // A new bot whose computer should run.
    createBot(userId: UserId, name: string, botToken: BotToken) {
      const row = db
        .query<BotRow, [string, string, string, string, number]>(
          `INSERT INTO bots (id, user_id, name, token_hash, running, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)
           RETURNING id, name, running`,
        )
        .get(`bot_${crypto.randomUUID()}`, userId, name, hash(botToken), Date.now());
      if (!row) throw new Error("bot insert returned no row");
      return toBotRecord(row);
    },

    botsFor(userId: UserId) {
      return db
        .query<BotRow, [string]>("SELECT id, name, running FROM bots WHERE user_id = ?1 ORDER BY created_at, id")
        .all(userId)
        .map(toBotRecord);
    },

    // Only the owner's bot: another user's bot id reads as missing.
    botFor(userId: UserId, botId: string) {
      const row = db
        .query<BotRow, [string, string]>("SELECT id, name, running FROM bots WHERE user_id = ?1 AND id = ?2")
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

    deleteBot(botId: BotId) {
      db.query("DELETE FROM bots WHERE id = ?1").run(botId);
    },

    // The bot owner's GitHub access token, for the bot's worker. Never the refresh token.
    githubTokenForBot(botId: BotId): BrokeredGitHubToken | null {
      const row = db
        .query<{ access_token: string; access_token_expires_at: number }, [string]>(
          `SELECT access_token, access_token_expires_at FROM github_tokens
           JOIN bots ON bots.user_id = github_tokens.user_id WHERE bots.id = ?1`,
        )
        .get(botId);
      return row ? { accessToken: row.access_token, expiresAt: row.access_token_expires_at } : null;
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

    // Whether control wants the bot's computer running; null for a deleted bot.
    botRunning(botId: BotId): boolean | null {
      const row = db.query<{ running: number }, [string]>("SELECT running FROM bots WHERE id = ?1").get(botId);
      return row ? row.running === 1 : null;
    },

    // nextDueAt is the routine's first due time, from the schedule.
    createRoutine(botId: BotId, { prompt, cron, timezone }: RoutineInput, nextDueAt: number): Routine {
      const row = db
        .query<RoutineRow, [string, string, string, string, string, number, number]>(
          `INSERT INTO routines (id, bot_id, prompt, cron, timezone, next_due_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING ${routineColumns}`,
        )
        .get(`routine_${crypto.randomUUID()}`, botId, prompt, cron, timezone, nextDueAt, Date.now());
      if (!row) throw new Error("routine insert returned no row");
      return toRoutine(row);
    },

    // Null when the bot has no such routine.
    updateRoutine(botId: BotId, routineId: string, { prompt, cron, timezone }: RoutineInput, nextDueAt: number): Routine | null {
      const row = db
        .query<RoutineRow, [string, string, string, string, string, number]>(
          `UPDATE routines SET prompt = ?3, cron = ?4, timezone = ?5, next_due_at = ?6
           WHERE id = ?1 AND bot_id = ?2 RETURNING ${routineColumns}`,
        )
        .get(routineId, botId, prompt, cron, timezone, nextDueAt);
      return row ? toRoutine(row) : null;
    },

    // False when the bot has no such routine.
    deleteRoutine(botId: BotId, routineId: string) {
      return db.query("DELETE FROM routines WHERE id = ?1 AND bot_id = ?2").run(routineId, botId).changes > 0;
    },

    routinesFor(botId: BotId): Routine[] {
      return db
        .query<RoutineRow, [string]>(`SELECT ${routineColumns} FROM routines WHERE bot_id = ?1 ORDER BY created_at, id`)
        .all(botId)
        .map(toRoutine);
    },

    // Claims every routine due by `now`: records a running run for its due time
    // and moves the routine to its next due time after now. Due times missed
    // while control was down collapse into one run. A due time claimed before
    // (by a control that then restarted) is not claimed again.
    claimDueRuns: db.transaction((now: number): Array<RunRef & { prompt: string }> => {
      const due = db
        .query<RoutineRow & { user_id: string }, [number]>(
          `SELECT routines.id, routines.bot_id, prompt, cron, timezone, next_due_at, bots.user_id FROM routines
           JOIN bots ON bots.id = routines.bot_id WHERE next_due_at <= ?1`,
        )
        .all(now);
      const claimed: Array<RunRef & { prompt: string }> = [];
      for (const row of due) {
        const next = nextDueAt(row.cron, row.timezone, now);
        if (next === null) throw new Error(`routine ${row.id} has no next due time`);
        db.query("UPDATE routines SET next_due_at = ?2 WHERE id = ?1").run(row.id, next);
        const inserted = db
          .query("INSERT OR IGNORE INTO routine_runs (routine_id, due_at, status) VALUES (?1, ?2, 'running')")
          .run(row.id, row.next_due_at);
        if (inserted.changes > 0) {
          const ref = toRunRef({ routine_id: row.id, due_at: row.next_due_at, bot_id: row.bot_id, user_id: row.user_id });
          claimed.push({ ...ref, prompt: row.prompt });
        }
      }
      return claimed;
    }),

    // The run started its bot's stopped computer, so it must stop it again.
    markRunStartedComputer(run: RunRef) {
      db.query("UPDATE routine_runs SET started_computer = 1 WHERE routine_id = ?1 AND due_at = ?2").run(run.routineId, run.dueAt);
    },
    // The chat turn the run sent.
    setRunTurn(run: RunRef, turnId: TurnId) {
      db.query("UPDATE routine_runs SET turn_id = ?3 WHERE routine_id = ?1 AND due_at = ?2").run(run.routineId, run.dueAt, turnId);
    },

    finishRun(run: RunRef, status: Exclude<RoutineRun["status"], "running">, error: string | null) {
      db.query("UPDATE routine_runs SET status = ?3, error = ?4 WHERE routine_id = ?1 AND due_at = ?2").run(
        run.routineId,
        run.dueAt,
        status,
        error,
      );
    },

    // Runs still marked running: their control stopped before they finished.
    unfinishedRuns(): Array<RunRef & { startedComputer: boolean }> {
      return db
        .query<{ routine_id: string; due_at: number; bot_id: string; user_id: string; started_computer: number }, []>(
          `SELECT routine_id, due_at, routines.bot_id, bots.user_id, started_computer FROM routine_runs
           JOIN routines ON routines.id = routine_runs.routine_id JOIN bots ON bots.id = routines.bot_id
           WHERE status = 'running'`,
        )
        .all()
        .map((row) => ({ ...toRunRef(row), startedComputer: row.started_computer === 1 }));
    },

    close: () => db.close(),
  };
}

function hash(token: string) {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}
