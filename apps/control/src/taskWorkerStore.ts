import type { Database } from "bun:sqlite";
import {
  ApprovalId,
  ChatEvent,
  CopilotPayer,
  ProjectId,
  TaskWorker,
  TaskWorkerId,
  TurnId,
  UserId,
  type ApprovalKind,
  type TaskWorkerState,
  type TurnEvent,
  type WorkspaceId,
} from "@chiefbot/contracts";

// A project's task workers in control's SQLite: each one's launch record, the
// events of its one turn (the task) and its approvals. openStore (store.ts)
// calls this once the projects tables exist. Methods that take an id from a URL
// or a tool call accept a plain string: an unknown one reads as missing.
export function taskWorkerStore(db: Database, hash: (token: string) => string) {
  // The launch record, written before control asks for a computer. (project_id,
  // creation_id) is unique, so a resent dispatch finds the worker it started.
  // user_id is the member who asked: their Copilot seat, their approvals.
  // `computer`: wanted while the worker may need it; unwanted once it must go
  // (the worker stopped, or its launch failed); removed once the provider
  // deleted it. A wanted computer of a done or abandoned task must go too;
  // one whose turn ended (finished, failed) is kept stopped until then.
  // `payer` is who pays for its Copilot (JSON), set when its task starts.
  // The worker's credential is stored as a SHA-256.
  db.run(`CREATE TABLE IF NOT EXISTS task_workers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_number INTEGER NOT NULL,
    creation_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL UNIQUE,
    prompt TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('launching', 'working', 'finished', 'failed', 'stopped')),
    computer TEXT NOT NULL CHECK (computer IN ('wanted', 'unwanted', 'removed')),
    result TEXT,
    pull_request TEXT,
    payer TEXT,
    next_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (project_id, creation_id),
    FOREIGN KEY (project_id, task_number) REFERENCES project_tasks (project_id, number) ON DELETE CASCADE
  )`);
  // The worker's turn as control stores it: its transcript.
  db.run(`CREATE TABLE IF NOT EXISTS task_worker_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT NOT NULL REFERENCES task_workers(id) ON DELETE CASCADE,
    event TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS task_worker_events_by_worker ON task_worker_events (worker_id, seq)");
  // What the worker asked the requester to approve, and the answer (NULL while pending).
  db.run(`CREATE TABLE IF NOT EXISTS task_worker_approvals (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES task_workers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    approved INTEGER
  )`);

  type WorkerRow = {
    id: string;
    project_id: string;
    task_number: number;
    login: string;
    payer: string | null;
    state: string;
    computer: string;
    result: string | null;
    pull_request: string | null;
    created_at: number;
    updated_at: number;
  };
  const workerColumns = `task_workers.id, task_workers.project_id, task_workers.task_number, users.login, task_workers.payer, task_workers.state,
    task_workers.computer, task_workers.result, task_workers.pull_request, task_workers.created_at, task_workers.updated_at
    FROM task_workers JOIN users ON users.id = task_workers.user_id`;
  // Approvals wait only while the worker works: a pending one of an ended turn can never be answered.
  const pendingApprovals = (workerId: string) =>
    db
      .query<{ id: string; kind: string; detail: string }, [string]>(
        `SELECT task_worker_approvals.id, kind, detail FROM task_worker_approvals JOIN task_workers ON task_workers.id = worker_id
         WHERE worker_id = ?1 AND approved IS NULL AND task_workers.state = 'working' ORDER BY task_worker_approvals.rowid`,
      )
      .all(workerId)
      .map((row) => ({ approvalId: row.id, kind: row.kind, detail: row.detail }));
  const toWorker = (row: WorkerRow): TaskWorker =>
    TaskWorker.parse({
      id: row.id,
      projectId: row.project_id,
      taskNumber: row.task_number,
      requestedBy: row.login,
      payer: row.payer === null ? null : CopilotPayer.parse(JSON.parse(row.payer)),
      state: row.state,
      result: row.result,
      pullRequest: row.pull_request,
      pendingApprovals: pendingApprovals(row.id),
      computerRemoved: row.computer === "removed",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  const worker = (workerId: string) => {
    const row = db.query<WorkerRow, [string]>(`SELECT ${workerColumns} WHERE task_workers.id = ?1`).get(workerId);
    return row ? toWorker(row) : null;
  };
  const touch = (workerId: string) => db.query("UPDATE task_workers SET updated_at = ?2 WHERE id = ?1").run(workerId, Date.now());

  type EventRow = { seq: number; turn_id: string; event: string };
  const toChatEvent = (row: EventRow) => ChatEvent.parse({ seq: row.seq, turnId: row.turn_id, event: JSON.parse(row.event) });
  const append = (workerId: string, event: ChatEvent["event"]) => {
    const row = db
      .query<EventRow, [string, string]>(
        `INSERT INTO task_worker_events (worker_id, event) VALUES (?1, ?2)
         RETURNING seq, (SELECT turn_id FROM task_workers WHERE id = ?1) AS turn_id, event`,
      )
      .get(workerId, JSON.stringify(event));
    if (!row) throw new Error("task worker event insert returned no row");
    return toChatEvent(row);
  };
  const transcript = (workerId: string): ChatEvent[] =>
    db
      .query<EventRow, [string]>(
        `SELECT seq, turn_id, event FROM task_worker_events JOIN task_workers ON task_workers.id = worker_id
         WHERE worker_id = ?1 ORDER BY seq`,
      )
      .all(workerId)
      .map(toChatEvent);

  // Ends the worker's turn from control's side, if it is still launching or working.
  const end = (workerId: string, state: "failed" | "stopped", message: string): ChatEvent[] => {
    const row = db
      .query<{ id: string }, [string, string, string, number]>(
        `UPDATE task_workers SET state = ?2, result = ?3, updated_at = ?4
         WHERE id = ?1 AND state IN ('launching', 'working') RETURNING id`,
      )
      .get(workerId, state, message, Date.now());
    if (!row) return [];
    return [append(workerId, { type: "error", message }), append(workerId, { type: "done" })];
  };

  return {
    // Writes the launch record of a worker for a task, unless the call that
    // starts it (`creationId`) wrote one already: then that worker, launched
    // false. `busy`, writing nothing, when another worker still works on the task.
    launch: db.transaction(
      (launch: {
        projectId: ProjectId;
        taskNumber: number;
        creationId: string;
        userId: UserId;
        prompt: string;
        token: string;
      }): { worker: TaskWorker; launched: boolean } | { busy: TaskWorker } => {
        const existing = db
          .query<{ id: string }, [string, string]>("SELECT id FROM task_workers WHERE project_id = ?1 AND creation_id = ?2")
          .get(launch.projectId, launch.creationId);
        const found = existing && worker(existing.id);
        if (found) return { worker: found, launched: false };
        const busy = db
          .query<WorkerRow, [string, number]>(
            `SELECT ${workerColumns} WHERE task_workers.project_id = ?1 AND task_workers.task_number = ?2
             AND task_workers.state IN ('launching', 'working')`,
          )
          .get(launch.projectId, launch.taskNumber);
        if (busy) return { busy: toWorker(busy) };
        const id = TaskWorkerId.parse(`worker_${crypto.randomUUID()}`);
        const now = Date.now();
        db.query(
          `INSERT INTO task_workers (id, project_id, task_number, creation_id, user_id, turn_id, prompt, token_hash, state, computer, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'launching', 'wanted', ?9, ?9)`,
        ).run(id, launch.projectId, launch.taskNumber, launch.creationId, launch.userId, `turn_${crypto.randomUUID()}`, launch.prompt, hash(launch.token), now);
        const created = worker(id);
        if (!created) throw new Error("task worker insert returned no row");
        return { worker: created, launched: true };
      },
    ),

    worker,

    // The project's worker, by an id from a URL or a tool call.
    workerIn(projectId: ProjectId, workerId: string): TaskWorker | null {
      const found = worker(workerId);
      return found?.projectId === projectId ? found : null;
    },

    // The project's workers, oldest first.
    workersOf(projectId: ProjectId): TaskWorker[] {
      return db
        .query<WorkerRow, [string]>(`SELECT ${workerColumns} WHERE task_workers.project_id = ?1 ORDER BY task_workers.created_at, task_workers.rowid`)
        .all(projectId)
        .map(toWorker);
    },

    // The worker a credential belongs to, the member who asked for it and its
    // turn, while that member is still in the project's workspace: once they
    // are not, the credential is refused on every route.
    forToken(token: string) {
      const row = db
        .query<{ id: string; project_id: string; user_id: string; turn_id: string }, [string]>(
          `SELECT task_workers.id, task_workers.project_id, task_workers.user_id, task_workers.turn_id FROM task_workers
           JOIN projects ON projects.id = task_workers.project_id
           JOIN workspace_members ON workspace_members.workspace_id = projects.workspace_id AND workspace_members.user_id = task_workers.user_id
           WHERE task_workers.token_hash = ?1`,
        )
        .get(hash(token));
      return row
        ? { workerId: TaskWorkerId.parse(row.id), projectId: ProjectId.parse(row.project_id), userId: UserId.parse(row.user_id), turnId: TurnId.parse(row.turn_id) }
        : null;
    },

    // The worker said hello for the first time: its task starts now, on `payer`'s
    // Copilot. Null when it already started (or ended), so the task is sent once.
    startTurn(workerId: TaskWorkerId, payer: CopilotPayer): { turnId: TurnId; prompt: string } | null {
      const row = db
        .query<{ turn_id: string; prompt: string }, [string, string, number]>(
          "UPDATE task_workers SET state = 'working', payer = ?2, updated_at = ?3 WHERE id = ?1 AND state = 'launching' RETURNING turn_id, prompt",
        )
        .get(workerId, JSON.stringify(payer), Date.now());
      return row ? { turnId: TurnId.parse(row.turn_id), prompt: row.prompt } : null;
    },

    // Its computer could not be made or started: it fails, and the computer must go.
    launchFailed: db.transaction((workerId: TaskWorkerId, message: string) => {
      end(workerId, "failed", message);
      db.query("UPDATE task_workers SET computer = 'unwanted' WHERE id = ?1 AND computer = 'wanted'").run(workerId);
    }),

    // Adds the worker's event number `index` to its working turn. `done` ends
    // the task: finished with the last message as the result, or failed with the
    // turn's error. Null, storing nothing, for a repeat or another turn.
    appendTurnEvent: db.transaction((workerId: TaskWorkerId, turnId: TurnId, index: number, event: TurnEvent): ChatEvent | null => {
      const updated = db
        .query(
          `UPDATE task_workers SET next_index = next_index + 1, updated_at = ?4
           WHERE id = ?1 AND turn_id = ?2 AND state = 'working' AND next_index = ?3 RETURNING id`,
        )
        .get(workerId, turnId, index, Date.now());
      if (!updated) return null;
      if (event.type === "approval-request") {
        db.query("INSERT INTO task_worker_approvals (id, worker_id, kind, detail) VALUES (?1, ?2, ?3, ?4)").run(
          event.approvalId,
          workerId,
          event.kind,
          event.detail,
        );
      }
      const stored = append(workerId, event);
      if (event.type === "done") {
        const { state, result } = outcome(transcript(workerId));
        db.query("UPDATE task_workers SET state = ?2, result = ?3 WHERE id = ?1").run(workerId, state, result);
      }
      return stored;
    }),

    // Ends the worker's turn from control's side (it was stopped, or lost the
    // turn): the events that end it, none when it was not running.
    end: db.transaction(end),

    // Stops the worker if it still runs, and marks its computer to go. The ending events.
    stop: db.transaction((workerId: TaskWorkerId, message: string): ChatEvent[] => {
      const ended = end(workerId, "stopped", message);
      db.query("UPDATE task_workers SET computer = 'unwanted', updated_at = ?2 WHERE id = ?1 AND computer = 'wanted'").run(workerId, Date.now());
      return ended;
    }),

    // Workers the member asked for in the workspace's projects that still launch or work.
    runningFor(workspaceId: WorkspaceId, userId: UserId): Array<{ workerId: TaskWorkerId; projectId: ProjectId }> {
      return db
        .query<{ id: string; project_id: string }, [string, string]>(
          `SELECT id, project_id FROM task_workers WHERE user_id = ?2 AND state IN ('launching', 'working')
           AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?1)`,
        )
        .all(workspaceId, userId)
        .map((row) => ({ workerId: TaskWorkerId.parse(row.id), projectId: ProjectId.parse(row.project_id) }));
    },

    // Workers of the project still launching or working, e.g. to stop them.
    running(projectId: ProjectId, taskNumber?: number): TaskWorkerId[] {
      return db
        .query<{ id: string }, [string, number | null]>(
          `SELECT id FROM task_workers WHERE project_id = ?1 AND state IN ('launching', 'working') AND (?2 IS NULL OR task_number = ?2)`,
        )
        .all(projectId, taskNumber ?? null)
        .map((row) => TaskWorkerId.parse(row.id));
    },

    // Every worker still launching, anywhere: after a control restart, each one's
    // launch may have been cut short.
    launching(): TaskWorkerId[] {
      return db
        .query<{ id: string }, []>("SELECT id FROM task_workers WHERE state = 'launching'")
        .all()
        .map((row) => TaskWorkerId.parse(row.id));
    },

    // Workers whose turn ended (finished or failed) and whose computer is kept
    // until their task closes: it should be stopped.
    ended(): TaskWorkerId[] {
      return db
        .query<{ id: string }, []>("SELECT id FROM task_workers WHERE state IN ('finished', 'failed') AND computer = 'wanted'")
        .all()
        .map((row) => TaskWorkerId.parse(row.id));
    },

    // Workers whose computer must go and may still exist: unwanted, or wanted by
    // a task that is done or abandoned. With `projectId`, every computer of the project not yet removed.
    toReap(projectId?: ProjectId): TaskWorkerId[] {
      return db
        .query<{ id: string }, [string | null]>(
          `SELECT task_workers.id FROM task_workers JOIN project_tasks
             ON project_tasks.project_id = task_workers.project_id AND project_tasks.number = task_workers.task_number
           WHERE CASE WHEN ?1 IS NULL
             THEN task_workers.computer = 'unwanted' OR (task_workers.computer = 'wanted' AND project_tasks.status IN ('done', 'abandoned'))
             ELSE task_workers.project_id = ?1 AND task_workers.computer != 'removed' END`,
        )
        .all(projectId ?? null)
        .map((row) => TaskWorkerId.parse(row.id));
    },

    // The provider deleted the worker's computer.
    computerRemoved(workerId: TaskWorkerId) {
      db.query("UPDATE task_workers SET computer = 'removed', updated_at = ?2 WHERE id = ?1").run(workerId, Date.now());
    },

    // The pull request the worker opened. Keeps the first.
    setPullRequest(workerId: TaskWorkerId, url: string) {
      db.query("UPDATE task_workers SET pull_request = COALESCE(pull_request, ?2), updated_at = ?3 WHERE id = ?1").run(workerId, url, Date.now());
    },

    // An approval control itself asks for (a push or a pull request), recorded in
    // the worker's turn like its own. Null when the worker is not working.
    requestApproval: db.transaction(
      (workerId: TaskWorkerId, ask: { approvalId: ApprovalId; kind: ApprovalKind; detail: string }): ChatEvent | null => {
        const working = db.query("SELECT 1 FROM task_workers WHERE id = ?1 AND state = 'working'").get(workerId);
        if (!working) return null;
        db.query("INSERT INTO task_worker_approvals (id, worker_id, kind, detail) VALUES (?1, ?2, ?3, ?4)").run(
          ask.approvalId,
          workerId,
          ask.kind,
          ask.detail,
        );
        touch(workerId);
        return append(workerId, { type: "approval-request", ...ask });
      },
    ),

    // Records the requester's answer to one of the working worker's pending
    // approvals. Null, storing nothing, when there is no such pending approval.
    answerApproval: db.transaction((workerId: TaskWorkerId, approvalId: string, approved: boolean): ChatEvent | null => {
      const row = db
        .query<{ id: string }, [string, string, number]>(
          `UPDATE task_worker_approvals SET approved = ?3 WHERE id = ?1 AND worker_id = ?2 AND approved IS NULL
           AND worker_id IN (SELECT id FROM task_workers WHERE state = 'working') RETURNING id`,
        )
        .get(approvalId, workerId, approved ? 1 : 0);
      if (!row) return null;
      touch(workerId);
      return append(workerId, { type: "approval-answer", approvalId: ApprovalId.parse(row.id), approved });
    }),

    // The worker's answered approvals, for a worker that may have missed the answers.
    answeredApprovals(workerId: TaskWorkerId) {
      return db
        .query<{ id: string; approved: number }, [string]>(
          "SELECT id, approved FROM task_worker_approvals WHERE worker_id = ?1 AND approved IS NOT NULL",
        )
        .all(workerId)
        .map((row) => ({ approvalId: ApprovalId.parse(row.id), approved: row.approved === 1 }));
    },

    // Everything the worker's turn did so far, oldest first.
    transcript,
  };
}

// How a turn that ended went: failed with its last error, or finished with its
// last assistant message as the result.
function outcome(events: ChatEvent[]): { state: TaskWorkerState; result: string | null } {
  const messages = new Map<string, string>();
  let error: string | null = null;
  for (const { event } of events) {
    if (event.type === "text-delta") messages.set(event.messageId, (messages.get(event.messageId) ?? "") + event.text);
    if (event.type === "error") error = event.message;
  }
  if (error !== null) return { state: "failed", result: error };
  return { state: "finished", result: [...messages.values()].at(-1)?.trim() || null };
}
