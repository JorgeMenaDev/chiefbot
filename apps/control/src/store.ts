import { Database } from "bun:sqlite";
import {
  AccessMode,
  AttachmentId,
  BotAvatar,
  BotId,
  AUTO_MODEL,
  DEFAULT_ACCESS,
  DEFAULT_AVATAR,
  CopilotPlan,
  Routine,
  RoutineId,
  ModelReport,
  ReasoningEffort,
  TurnId,
  UserId,
  type ApprovalId,
  type ApprovalKind,
  type AttachmentUpload,
  type BotToken,
  type ChatEvent,
  type HandoffUpdate,
  type TurnEvent,
  type GitHubTokens,
  type RoutineInput,
  type RoutineRun,
  type SessionToken,
  type User,
  type UserMessage,
} from "@chiefbot/contracts";
import { addColumn } from "./addColumn.ts";
import { acceptEvent, approvalRecords, toChatEvent, type ChatEventRow } from "./turnRecords.ts";
import type { GitHubIdentity } from "./github.ts";
import { handoffStore } from "./handoffStore.ts";
import { nextDueAt } from "./schedule.ts";
import { connectionStore } from "./connections/connectionStore.ts";
import { connectorStore } from "./connectors/connectorStore.ts";
import { healthStore } from "./health/healthStore.ts";
import { serviceStore } from "./health/serviceStore.ts";
import { projectStore } from "./projectStore.ts";
import { subscriptionStore } from "./subscriptionStore.ts";
import { taskWorkerStore } from "./taskWorkerStore.ts";
import { turnKeyStore } from "./turnKeys.ts";
import { workspaceStore } from "./workspaceStore.ts";

// Control's durable state in SQLite. Every row hangs off a user or a workspace.
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
  // What a bot asked the user to approve, and the answer (NULL while pending)
  // (turnRecords.ts approvalRecords). The request itself is in chat_events too.
  db.run(`CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    approved INTEGER
  )`);
  // The files sent with a turn's message (chat.ts SentAttachment), with their bytes.
  db.run(`CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    data BLOB NOT NULL
  )`);

  // Columns added after the tables first shipped.
  // The bot's Copilot model id, and its reasoning effort (NULL: the model's default).
  addColumn(db, "bots", "model", `TEXT NOT NULL DEFAULT '${AUTO_MODEL}'`);
  addColumn(db, "bots", "effort", "TEXT");
  // The bot's access mode (contracts AccessMode). Bots from before access modes run on the default.
  addColumn(db, "bots", "access", `TEXT NOT NULL DEFAULT '${DEFAULT_ACCESS}'`);
  // The bot's face (contracts BotAvatar). Bots from before faces wear the default.
  addColumn(db, "bots", "avatar_shape", `TEXT NOT NULL DEFAULT '${DEFAULT_AVATAR.shape}'`);
  addColumn(db, "bots", "avatar_color", `TEXT NOT NULL DEFAULT '${DEFAULT_AVATAR.color}'`);
  // The latest ModelReport (JSON) a worker of the user's bots sent: control's cache of their plan's models.
  addColumn(db, "users", "copilot_models", "TEXT");
  // 0 until the user's first bot is claimed (claimFirstBot). Users from before first bots count as claimed.
  addColumn(db, "users", "first_bot_claimed", "INTEGER NOT NULL DEFAULT 1");
  // What each approval asked and when, as for task workers and coordinators.
  addColumn(db, "approvals", "kind", "TEXT NOT NULL DEFAULT 'tool'");
  addColumn(db, "approvals", "detail", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "approvals", "requested_at", "INTEGER NOT NULL DEFAULT 0");

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

  type BotRow = {
    id: string;
    name: string;
    running: number;
    model: string;
    effort: string | null;
    access: string;
    avatar_shape: string;
    avatar_color: string;
  };
  const botColumns = "id, name, running, model, effort, access, avatar_shape, avatar_color";
  const toBotRecord = (row: BotRow) => ({
    id: BotId.parse(row.id),
    name: row.name,
    avatar: BotAvatar.parse({ shape: row.avatar_shape, color: row.avatar_color }),
    running: row.running === 1,
    model: row.model,
    effort: ReasoningEffort.nullable().parse(row.effort),
    access: AccessMode.parse(row.access),
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

  const approvals = approvalRecords(db, { table: "approvals", owner: "bot_id", liveTurns: "SELECT id FROM turns WHERE done = 0" });
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

  const workspaces = workspaceStore(db);
  const projects = projectStore(db, hash);
  const connectors = connectorStore(db);
  const connections = connectionStore(db);
  const health = healthStore(db);
  const services = serviceStore(db);
  const subscriptions = subscriptionStore(db, projects);
  // A note from control in a bot's chat, in a turn of its own that is done already.
  const postNotice = (botId: BotId, notice: HandoffUpdate) => {
    const turnId = TurnId.parse(`turn_${crypto.randomUUID()}`);
    db.query("INSERT INTO turns (id, bot_id, done, created_at) VALUES (?1, ?2, 1, ?3)").run(turnId, botId, Date.now());
    return append(botId, turnId, notice);
  };
  const handoffs = handoffStore(db, projects, postNotice);
  const taskWorkers = taskWorkerStore(db, hash);
  const turnKeys = turnKeyStore(db, hash);

  return {
    // Workspaces, members and invites (workspaceStore.ts).
    workspaces,
    // Projects, task ledgers and coordinator chats (projectStore.ts).
    projects,
    // Connectors, members' sign-ins to them and their call log (connectors/connectorStore.ts).
    connectors,
    // People's connections and their bots' call log (connections/connectionStore.ts).
    connections,
    // The health checks of people's connections (health/healthStore.ts).
    health,
    // People's own services on Health and their checks (health/serviceStore.ts).
    services,
    // What chiefs of staff handed to projects (handoffStore.ts).
    handoffs,
    // Projects' subscriptions and the events they saw (subscriptionStore.ts).
    subscriptions,
    // Projects' task workers: launch records, transcripts, approvals (taskWorkerStore.ts).
    taskWorkers,
    // Every agent's running turns' keys (turnKeys.ts).
    turnKeys,

    // Creates or updates the user GitHub identified.
    upsertUser(identity: GitHubIdentity): UserId {
      const row = db
        .query<{ id: string }, [string, number, string, string]>(
          `INSERT INTO users (id, github_id, login, copilot_plan, first_bot_claimed) VALUES (?1, ?2, ?3, ?4, 0)
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

    // Whether the user still had their first bot to get, claiming it: true once per
    // user, so concurrent sign-ins make one bot. releaseFirstBot gives it back.
    claimFirstBot(userId: UserId) {
      return db.query("UPDATE users SET first_bot_claimed = 1 WHERE id = ?1 AND first_bot_claimed = 0").run(userId).changes === 1;
    },

    releaseFirstBot(userId: UserId) {
      db.query("UPDATE users SET first_bot_claimed = 0 WHERE id = ?1").run(userId);
    },

    // A new bot whose computer should run.
    createBot(userId: UserId, name: string, avatar: BotAvatar, botToken: BotToken) {
      const row = db
        .query<BotRow, [string, string, string, string, number, string, string]>(
          `INSERT INTO bots (id, user_id, name, token_hash, running, created_at, avatar_shape, avatar_color)
           VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7) RETURNING ${botColumns}`,
        )
        .get(`bot_${crypto.randomUUID()}`, userId, name, hash(botToken), Date.now(), avatar.shape, avatar.color);
      if (!row) throw new Error("bot insert returned no row");
      return toBotRecord(row);
    },

    botsFor(userId: UserId) {
      return db
        .query<BotRow, [string]>(`SELECT ${botColumns} FROM bots WHERE user_id = ?1 ORDER BY created_at, id`)
        .all(userId)
        .map(toBotRecord);
    },

    // Only the owner's bot: another user's bot id reads as missing.
    botFor(userId: UserId, botId: string) {
      const row = db
        .query<BotRow, [string, string]>(`SELECT ${botColumns} FROM bots WHERE user_id = ?1 AND id = ?2`)
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

    setBotModel(botId: BotId, model: string, effort: ReasoningEffort | null) {
      db.query("UPDATE bots SET model = ?2, effort = ?3 WHERE id = ?1").run(botId, model, effort);
    },

    setBotAccess(botId: BotId, access: AccessMode) {
      db.query("UPDATE bots SET access = ?2 WHERE id = ?1").run(botId, access);
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

    // Opens a turn with the user's message and the files sent with it.
    startTurn: db.transaction((botId: BotId, text: string, uploads: AttachmentUpload[] = []): ChatEvent & { event: UserMessage } => {
      const turnId = TurnId.parse(`turn_${crypto.randomUUID()}`);
      db.query("INSERT INTO turns (id, bot_id, done, created_at) VALUES (?1, ?2, 0, ?3)").run(turnId, botId, Date.now());
      const attachments = uploads.map(({ name, mimeType, data }) => {
        const id = AttachmentId.parse(`attachment_${crypto.randomUUID()}`);
        const bytes = Buffer.from(data, "base64");
        db.query("INSERT INTO attachments (id, bot_id, turn_id, name, mime_type, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(id, botId, turnId, name, mimeType, bytes);
        return { id, name, mimeType, size: bytes.length };
      });
      const event: UserMessage = { type: "user-message", text, ...(attachments.length > 0 ? { attachments } : {}) };
      return { ...append(botId, turnId, event), event };
    }),

    // A file sent with one of the bot's messages, or with `turnId` only one of that turn's. Null when there is none.
    attachment(botId: BotId, attachmentId: string, turnId: TurnId | null = null) {
      return db
        .query<{ mime_type: string; data: Uint8Array }, [string, string, string | null]>(
          "SELECT mime_type, data FROM attachments WHERE id = ?1 AND bot_id = ?2 AND (?3 IS NULL OR turn_id = ?3)",
        )
        .get(attachmentId, botId, turnId);
    },

    // Adds the worker's event number `index` to the bot's unfinished turn; `done`
    // finishes it and an approval-request records a pending approval. Null,
    // storing nothing, for a repeat or another bot's or a done turn.
    appendTurnEvent: db.transaction((botId: BotId, turnId: TurnId, index: number, event: TurnEvent): ChatEvent | null => {
      if (!acceptEvent(db, "turns", "id = ?1 AND bot_id = ?2 AND done = 0", [turnId, botId], index)) return null;
      if (event.type === "done") db.query("UPDATE turns SET done = 1 WHERE id = ?1").run(turnId);
      if (event.type === "approval-request") approvals.record(botId, turnId, event, Date.now());
      return append(botId, turnId, event);
    }),

    // An approval control itself asks for (a push or a pull request), recorded in
    // the bot's turn like the worker's own. Null when that turn is done.
    requestApproval: db.transaction((botId: BotId, turnId: TurnId, ask: { approvalId: ApprovalId; kind: ApprovalKind; detail: string }): ChatEvent | null => {
      if (!db.query("SELECT 1 FROM turns WHERE id = ?1 AND bot_id = ?2 AND done = 0").get(turnId, botId)) return null;
      approvals.record(botId, turnId, ask, Date.now());
      return append(botId, turnId, { type: "approval-request", ...ask });
    }),

    // Records the user's answer to a pending approval of the bot's unfinished
    // turn. Null, storing nothing, when there is no such pending approval.
    answerApproval: db.transaction((botId: BotId, approvalId: ApprovalId, approved: boolean): ChatEvent | null => {
      const answered = approvals.answer(botId, approvalId, approved);
      return answered && append(botId, answered.turnId, { type: "approval-answer", approvalId, approved });
    }),

    // Whether one of the bot's unfinished turns waits on the user's answer.
    waitingOnApproval: (botId: BotId) => approvals.pending(botId).length > 0,

    // The answered approvals of one of the bot's turns, for its worker, which may
    // have missed the answers. Another bot's turn has none.
    answeredApprovals: (botId: BotId, turnId: TurnId) => approvals.answered(botId, turnId),

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

    // Every bot whose computer control wants running, with its owner.
    runningBots() {
      return db
        .query<{ id: string; user_id: string }, []>("SELECT id, user_id FROM bots WHERE running = 1")
        .all()
        .map((row) => ({ botId: BotId.parse(row.id), userId: UserId.parse(row.user_id) }));
    },

    // Whether one of the bot's routines has a run in progress.
    routineRunning(botId: BotId) {
      return (
        db
          .query<{ due_at: number }, [string]>(
            `SELECT routine_runs.due_at FROM routine_runs JOIN routines ON routines.id = routine_runs.routine_id
             WHERE routines.bot_id = ?1 AND routine_runs.status = 'running' LIMIT 1`,
          )
          .get(botId) !== null
      );
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
