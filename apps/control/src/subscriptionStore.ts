import type { Database } from "bun:sqlite";
import {
  ProjectId,
  Subscription,
  SubscriptionId,
  UserId,
  type CallIdentity,
  type ChatEvent,
  type SubscriptionInput,
  type Task,
} from "@chiefbot/contracts";
import type { projectStore } from "./projectStore.ts";
import { nextDueAt } from "./schedule.ts";

// One event a subscription saw. `id` is stable: the same run, issue update or
// due time always gives the same id, so it is handled once.
export type SeenEvent = { id: string; title: string; detail: string; url: string | null };

// What handling a new event made: its task, and the message queued for the
// coordinator in the chat of the member who added the subscription.
export type HandledEvent = { projectId: ProjectId; userId: UserId; task: Task; queued: ChatEvent };

// A subscription due for a poll.
export type DuePoll = { id: SubscriptionId; projectId: ProjectId; userId: UserId; source: Exclude<SubscriptionInput, { kind: "schedule" }> };

// Projects' subscriptions and the events each has seen, in control's SQLite.
// openStore (store.ts) calls this once the projects table exists.
export function subscriptionStore(db: Database, projects: ReturnType<typeof projectStore>) {
  // `source` is the SubscriptionInput as JSON. `baselined`: a first poll has
  // noted what was already there. `identity` is whose credential the last poll used.
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    next_due_at INTEGER NOT NULL,
    baselined INTEGER NOT NULL DEFAULT 0,
    last_polled_at INTEGER,
    last_error TEXT,
    identity TEXT,
    created_at INTEGER NOT NULL
  )`);
  // Every event a subscription has seen, by its stable id: the dedupe record.
  // task_number is the task it became; NULL for what a first poll found.
  db.run(`CREATE TABLE IF NOT EXISTS subscription_events (
    subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    task_number INTEGER,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (subscription_id, event_id)
  )`);

  type Row = {
    id: string;
    project_id: string;
    user_id: string;
    login: string;
    source: string;
    next_due_at: number;
    baselined: number;
    last_polled_at: number | null;
    last_error: string | null;
    identity: string | null;
    events: number;
  };
  const select = `SELECT subscriptions.*, users.login,
      (SELECT COUNT(*) FROM subscription_events WHERE subscription_id = subscriptions.id AND task_number IS NOT NULL) AS events
    FROM subscriptions JOIN users ON users.id = subscriptions.user_id`;
  const toSubscription = (row: Row): Subscription =>
    Subscription.parse({
      id: row.id,
      projectId: row.project_id,
      addedBy: row.login,
      source: JSON.parse(row.source),
      nextDueAt: row.next_due_at,
      lastPolledAt: row.last_polled_at,
      lastError: row.last_error,
      identity: row.identity,
      events: row.events,
    });
  const byId = (id: string) => db.query<Row, [string]>(`${select} WHERE subscriptions.id = ?1`).get(id);

  // Records one event of the subscription. A new one becomes a task and a
  // coordinator message, unless `quiet` (a first poll's); a repeat does nothing.
  function handle(row: Row, event: SeenEvent, quiet: boolean, now: number): HandledEvent | null {
    const inserted = db
      .query("INSERT OR IGNORE INTO subscription_events (subscription_id, event_id, seen_at) VALUES (?1, ?2, ?3)")
      .run(row.id, event.id, now);
    if (inserted.changes === 0 || quiet) return null;
    const projectId = ProjectId.parse(row.project_id);
    const userId = UserId.parse(row.user_id);
    const created = projects.createTask(projectId, { title: event.title.slice(0, 200), detail: event.detail, owner: null }, row.login);
    const task = event.url === null ? created : (projects.updateTask(projectId, { number: created.number, links: [{ kind: "url", url: event.url }] }) ?? created);
    db.query("UPDATE subscription_events SET task_number = ?3 WHERE subscription_id = ?1 AND event_id = ?2").run(row.id, event.id, task.number);
    const queued = projects.queueTurn(projectId, userId, toCoordinator(toSubscription(row).source, event, task.number), true);
    if (!queued) throw new Error("a subscription's message was not queued");
    return { projectId, userId, task, queued };
  }

  return {
    // A new subscription of the member to the project, due at `firstDueAt`.
    create(projectId: ProjectId, userId: UserId, source: SubscriptionInput, firstDueAt: number): Subscription {
      const id = `subscription_${crypto.randomUUID()}`;
      db.query("INSERT INTO subscriptions (id, project_id, user_id, source, next_due_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(
        id,
        projectId,
        userId,
        JSON.stringify(source),
        firstDueAt,
        Date.now(),
      );
      const row = byId(id);
      if (!row) throw new Error("subscription insert returned no row");
      return toSubscription(row);
    },

    // The project's subscriptions, oldest first.
    of(projectId: ProjectId): Subscription[] {
      return db.query<Row, [string]>(`${select} WHERE project_id = ?1 ORDER BY subscriptions.created_at, subscriptions.rowid`).all(projectId).map(toSubscription);
    },

    // False when the project has no such subscription.
    delete(projectId: ProjectId, id: string) {
      return db.query("DELETE FROM subscriptions WHERE id = ?1 AND project_id = ?2").run(id, projectId).changes > 0;
    },

    // Claims every subscription due by `now` and moves it to its next due time.
    // A subscription whose member left the project's workspace is not claimed.
    // A schedule's due time is handled right here, in the same transaction, so
    // it becomes one task even if control stops a moment later; missed due
    // times collapse into one. Polls are returned for the caller to run.
    claimDue: db.transaction((now: number): { handled: HandledEvent[]; polls: DuePoll[] } => {
      const handled: HandledEvent[] = [];
      const polls: DuePoll[] = [];
      const due = db
        .query<Row, [number]>(
          `${select} WHERE next_due_at <= ?1 AND EXISTS (SELECT 1 FROM workspace_members JOIN projects ON projects.workspace_id = workspace_members.workspace_id
             WHERE projects.id = subscriptions.project_id AND workspace_members.user_id = subscriptions.user_id)`,
        )
        .all(now);
      for (const row of due) {
        const { source } = toSubscription(row);
        if (source.kind === "schedule") {
          const next = nextDueAt(source.cron, source.timezone, now);
          if (next === null) throw new Error(`subscription ${row.id} has no next due time`);
          db.query("UPDATE subscriptions SET next_due_at = ?2 WHERE id = ?1").run(row.id, next);
          const event = handle(row, scheduledEvent(source, row.next_due_at), false, now);
          if (event) handled.push(event);
          continue;
        }
        db.query("UPDATE subscriptions SET next_due_at = ?2 WHERE id = ?1").run(row.id, now + source.intervalSeconds * 1000);
        polls.push({ id: SubscriptionId.parse(row.id), projectId: ProjectId.parse(row.project_id), userId: UserId.parse(row.user_id), source });
      }
      return { handled, polls };
    }),

    // Records a poll's result: the events it saw (the first poll's only as already
    // there), or the error that stopped it. Null when the subscription is gone.
    polled: db.transaction(
      (id: SubscriptionId, at: number, result: { identity: CallIdentity; events: SeenEvent[] } | { error: string }): HandledEvent[] | null => {
        const row = byId(id);
        if (!row) return null;
        if ("error" in result) {
          db.query("UPDATE subscriptions SET last_polled_at = ?2, last_error = ?3 WHERE id = ?1").run(id, at, result.error);
          return [];
        }
        const handled = result.events.flatMap((event) => handle(row, event, row.baselined === 0, at) ?? []);
        db.query("UPDATE subscriptions SET last_polled_at = ?2, last_error = NULL, identity = ?3, baselined = 1 WHERE id = ?1").run(id, at, result.identity);
        return handled;
      },
    ),
  };
}

// A schedule's event for one due time.
function scheduledEvent(source: Extract<SubscriptionInput, { kind: "schedule" }>, dueAt: number): SeenEvent {
  const firstLine = source.prompt.split("\n")[0] ?? source.prompt;
  return { id: `schedule:${dueAt}`, title: `Scheduled: ${firstLine}`, detail: source.prompt, url: null };
}

// What the coordinator reads for a new event, in the subscriber's chat.
function toCoordinator(source: SubscriptionInput, event: SeenEvent, taskNumber: number) {
  const what =
    source.kind === "ci-status"
      ? `CI on ${source.branch}`
      : source.kind === "issue-query"
        ? `the issue query "${source.query}"`
        : `the schedule ${source.cron} (${source.timezone})`;
  return [
    `The project's subscription to ${what} saw this. It is task #${taskNumber} in the ledger: work on that task, and do not add another for it.`,
    "",
    event.title,
    event.detail,
    "",
    `Set task #${taskNumber} to done once it is handled, or abandoned if nothing needs doing.`,
  ].join("\n");
}
