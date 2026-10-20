import type { Database } from "bun:sqlite";
import {
  CopilotPayer,
  ProjectId,
  SetupStep,
  TaskWorker,
  TaskWorkerId,
  TurnId,
  UserId,
  type ApprovalId,
  type ApprovalKind,
  type ChatEvent,
  type TaskWorkerState,
  type TurnEvent,
  type VerdictResult,
  type WorkspaceId,
} from "@chiefbot/contracts";
import { addColumn } from "./addColumn.ts";
import type { projectStore } from "./projectStore.ts";
import { rebuildTable } from "./rebuildTable.ts";
import { acceptEvent, approvalRecords, toChatEvent, type ChatEventRow } from "./turnRecords.ts";

// A project's task workers in control's SQLite: each one's launch record, the
// events of its one turn (the task) and its approvals. openStore (store.ts)
// calls this once the projects tables exist. Methods that take an id from a URL
// or a tool call accept a plain string: an unknown one reads as missing.
export function taskWorkerStore(db: Database, hash: (token: string) => string, projects: ReturnType<typeof projectStore>) {
  // The launch record, written before control asks for a computer (or queues
  // it). (project_id, creation_id) is unique, so a resent dispatch finds the
  // worker it started. user_id is the member who asked: their Copilot seat,
  // their approvals. `computer`: wanted while the worker may need it; kept once
  // its turn ended (finished, blocked, failed) and the provider stopped it, its
  // disk kept until its task closes; unwanted once it must go (the worker
  // stopped, or its launch failed); removed once the provider deleted it, or a
  // queued worker stopped before it had one. A wanted or kept computer of a done
  // or abandoned task must go too. A worker that has started holds one of its
  // project's places (workers.max) while its computer is wanted or unwanted, so
  // a computer that is slow or fails to stop or go keeps its place until it has. `payer` is who pays
  // for its Copilot (JSON), set when its task starts. `setup` is a JSON array of
  // the SetupSteps it ran. The worker's credential is stored as a SHA-256: a
  // queued worker's is replaced as it launches.
  const create = `CREATE TABLE IF NOT EXISTS task_workers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_number INTEGER NOT NULL,
    creation_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL UNIQUE,
    prompt TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('queued', 'launching', 'setting_up', 'working', 'finished', 'blocked', 'failed', 'stopped')),
    computer TEXT NOT NULL CHECK (computer IN ('wanted', 'kept', 'unwanted', 'removed')),
    result TEXT,
    pull_request TEXT,
    payer TEXT,
    setup TEXT NOT NULL DEFAULT '[]',
    next_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (project_id, creation_id),
    FOREIGN KEY (project_id, task_number) REFERENCES project_tasks (project_id, number) ON DELETE CASCADE
  )`;
  db.run(create);
  // A table from before engineers set up (no 'setting_up' state) is made again.
  rebuildTable(db, "task_workers", create, "'kept'");
  // Columns added after the table first shipped. `kind` is engineer or verifier.
  // A verifier's `sha` is the commit it checks and `branch` the pull request's
  // branch (in `pull_request`) then, at the `revision` of the pushes through
  // Chiefbot to that branch (projectStore.ts branch_pushes; NULL when one was in
  // flight then); `verdict` is the result it ended with, once it has one.
  addColumn(db, "task_workers", "kind", "TEXT NOT NULL DEFAULT 'engineer'");
  addColumn(db, "task_workers", "sha", "TEXT");
  addColumn(db, "task_workers", "branch", "TEXT");
  addColumn(db, "task_workers", "verdict", "TEXT");
  addColumn(db, "task_workers", "revision", "INTEGER");
  // The worker's turn as control stores it: its transcript.
  db.run(`CREATE TABLE IF NOT EXISTS task_worker_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT NOT NULL REFERENCES task_workers(id) ON DELETE CASCADE,
    event TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS task_worker_events_by_worker ON task_worker_events (worker_id, seq)");
  // What the worker (or control, for it) asked the requester to approve, when
  // (control's clock: its wait limit counts from then), and the answer (NULL
  // while pending) (turnRecords.ts approvalRecords).
  db.run(`CREATE TABLE IF NOT EXISTS task_worker_approvals (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES task_workers(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    approved INTEGER
  )`);
  // Columns added after the table first shipped. A worker has one turn, so an
  // older approval's turn is its worker's.
  addColumn(db, "task_worker_approvals", "turn_id", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "task_worker_approvals", "requested_at", "INTEGER NOT NULL DEFAULT 0");
  db.run(`UPDATE task_worker_approvals SET turn_id = (SELECT turn_id FROM task_workers WHERE task_workers.id = worker_id) WHERE turn_id = ''`);
  // Each ended worker's continuation (continueTask): the coordinator turn control
  // queued for it, or NULL when it queued none. One row per worker, so one ending
  // continues its task once, across restarts. Workers that had ended when the
  // table was made count as continued: an upgrade starts no burst of turns.
  const continuationsExisted = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_continuations'").get() !== null;
  db.run(`CREATE TABLE IF NOT EXISTS task_continuations (
    worker_id TEXT PRIMARY KEY REFERENCES task_workers(id) ON DELETE CASCADE,
    turn_id TEXT
  )`);
  if (!continuationsExisted) db.run(`INSERT INTO task_continuations (worker_id) SELECT id FROM task_workers WHERE state IN (${ended})`);
  // Approvals wait only while the worker works: a pending one of an ended turn can never be answered.
  const approvals = approvalRecords(db, {
    table: "task_worker_approvals",
    owner: "worker_id",
    liveTurns: "SELECT turn_id FROM task_workers WHERE state = 'working'",
  });

  type WorkerRow = {
    id: string;
    project_id: string;
    kind: string;
    task_number: number;
    login: string;
    payer: string | null;
    state: string;
    setup: string;
    computer: string;
    result: string | null;
    pull_request: string | null;
    sha: string | null;
    branch: string | null;
    verdict: string | null;
    created_at: number;
    updated_at: number;
  };
  const workerColumns = `task_workers.id, task_workers.project_id, task_workers.kind, task_workers.task_number, users.login, task_workers.payer,
    task_workers.state, task_workers.setup, task_workers.computer, task_workers.result, task_workers.pull_request, task_workers.sha,
    task_workers.branch, task_workers.verdict, task_workers.created_at, task_workers.updated_at
    FROM task_workers JOIN users ON users.id = task_workers.user_id`;
  const toWorker = (row: WorkerRow): TaskWorker =>
    TaskWorker.parse({
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      taskNumber: row.task_number,
      requestedBy: row.login,
      payer: row.payer === null ? null : CopilotPayer.parse(JSON.parse(row.payer)),
      state: row.state,
      setup: SetupStep.array().parse(JSON.parse(row.setup)),
      result: row.result,
      pullRequest: row.pull_request,
      sha: row.sha,
      branch: row.branch,
      verdict: row.verdict,
      pendingApprovals: approvals.pending(row.id),
      computerRemoved: row.computer === "removed",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  const worker = (workerId: string) => {
    const row = db.query<WorkerRow, [string]>(`SELECT ${workerColumns} WHERE task_workers.id = ?1`).get(workerId);
    return row ? toWorker(row) : null;
  };
  const touch = (workerId: string) => db.query("UPDATE task_workers SET updated_at = ?2 WHERE id = ?1").run(workerId, Date.now());

  const append = (workerId: string, event: ChatEvent["event"]) => {
    const row = db
      .query<ChatEventRow, [string, string]>(
        `INSERT INTO task_worker_events (worker_id, event) VALUES (?1, ?2)
         RETURNING seq, (SELECT turn_id FROM task_workers WHERE id = ?1) AS turn_id, event`,
      )
      .get(workerId, JSON.stringify(event));
    if (!row) throw new Error("task worker event insert returned no row");
    return toChatEvent(row);
  };
  // The worker's events after the one numbered `after` (all of them by default), oldest first.
  const transcript = (workerId: string, after = 0): ChatEvent[] =>
    db
      .query<ChatEventRow, [string, number]>(
        `SELECT seq, turn_id, event FROM task_worker_events JOIN task_workers ON task_workers.id = worker_id
         WHERE worker_id = ?1 AND seq > ?2 ORDER BY seq`,
      )
      .all(workerId, after)
      .map(toChatEvent);

  // Ends the worker's turn from control's side, if it has not ended yet.
  const end = (workerId: string, state: "blocked" | "failed" | "stopped", message: string): ChatEvent[] => {
    const row = db
      .query<{ id: string }, [string, string, string, number]>(
        `UPDATE task_workers SET state = ?2, result = ?3, updated_at = ?4
         WHERE id = ?1 AND state IN (${unended}) RETURNING id`,
      )
      .get(workerId, state, message, Date.now());
    if (!row) return [];
    return [append(workerId, { type: "error", message }), append(workerId, { type: "done" })];
  };

  // How many of the project's places (workers.max) its workers hold now.
  const runningCount = (projectId: string) =>
    db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM task_workers WHERE project_id = ?1 AND state != 'queued' AND computer IN ('wanted', 'unwanted')")
      .get(projectId)?.n ?? 0;

  return {
    // Writes the launch record of a worker for a task, unless the call that
    // starts it (`creationId`) wrote one already: then that worker, launched
    // false. `busy`, writing nothing, when another worker still works on the
    // task. While the project already runs `max` workers, the new one is queued.
    // A verifier (`verifies`) checks a pull request at one commit, of a branch.
    launch: db.transaction(
      (launch: {
        projectId: ProjectId;
        taskNumber: number;
        creationId: string;
        userId: UserId;
        prompt: string;
        token: string;
        max: number;
        verifies?: { pullRequest: string; sha: string; branch: string; revision: number | null };
      }): { worker: TaskWorker; launched: boolean } | { busy: TaskWorker } => {
        const existing = db
          .query<{ id: string }, [string, string]>("SELECT id FROM task_workers WHERE project_id = ?1 AND creation_id = ?2")
          .get(launch.projectId, launch.creationId);
        const found = existing && worker(existing.id);
        if (found) return { worker: found, launched: false };
        const busy = db
          .query<WorkerRow, [string, number]>(
            `SELECT ${workerColumns} WHERE task_workers.project_id = ?1 AND task_workers.task_number = ?2
             AND task_workers.state IN (${unended})`,
          )
          .get(launch.projectId, launch.taskNumber);
        if (busy) return { busy: toWorker(busy) };
        const id = TaskWorkerId.parse(`worker_${crypto.randomUUID()}`);
        const now = Date.now();
        const state = runningCount(launch.projectId) < launch.max ? "launching" : "queued";
        const { verifies } = launch;
        db.query(
          `INSERT INTO task_workers (id, project_id, task_number, creation_id, user_id, turn_id, prompt, token_hash, state, computer, created_at, updated_at,
             kind, pull_request, sha, branch, revision)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'wanted', ?10, ?10, ?11, ?12, ?13, ?14, ?15)`,
        ).run(
          id,
          launch.projectId,
          launch.taskNumber,
          launch.creationId,
          launch.userId,
          `turn_${crypto.randomUUID()}`,
          launch.prompt,
          hash(launch.token),
          state,
          now,
          verifies ? "verifier" : "engineer",
          verifies?.pullRequest ?? null,
          verifies?.sha ?? null,
          verifies?.branch ?? null,
          verifies?.revision ?? null,
        );
        const created = worker(id);
        if (!created) throw new Error("task worker insert returned no row");
        return { worker: created, launched: true };
      },
    ),

    // The project's oldest queued worker launches with the credential `token`,
    // if the project runs fewer than `max` workers: its id, or null.
    dequeue: db.transaction((projectId: ProjectId, max: number, token: string): TaskWorkerId | null => {
      if (runningCount(projectId) >= max) return null;
      const row = db
        .query<{ id: string }, [string, string, number]>(
          `UPDATE task_workers SET state = 'launching', token_hash = ?2, updated_at = ?3
           WHERE id = (SELECT id FROM task_workers WHERE project_id = ?1 AND state = 'queued' ORDER BY created_at, rowid LIMIT 1)
           RETURNING id`,
        )
        .get(projectId, hash(token), Date.now());
      return row ? TaskWorkerId.parse(row.id) : null;
    }),

    // Projects with a queued worker: after a restart, each may have room for one.
    queuedProjects(): ProjectId[] {
      return db
        .query<{ project_id: string }, []>("SELECT DISTINCT project_id FROM task_workers WHERE state = 'queued'")
        .all()
        .map((row) => ProjectId.parse(row.project_id));
    },

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
    // are not, its WebSocket is refused. (Every other route takes a turn key.)
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
    // Copilot, with its setup. Null when it already started (or ended), so the task is sent once.
    startTurn(workerId: TaskWorkerId, payer: CopilotPayer): { turnId: TurnId; prompt: string } | null {
      const row = db
        .query<{ turn_id: string; prompt: string }, [string, string, number]>(
          "UPDATE task_workers SET state = 'setting_up', payer = ?2, updated_at = ?3 WHERE id = ?1 AND state = 'launching' RETURNING turn_id, prompt",
        )
        .get(workerId, JSON.stringify(payer), Date.now());
      return row ? { turnId: TurnId.parse(row.turn_id), prompt: row.prompt } : null;
    },

    // Its computer could not be made or started: it fails, and the computer must go.
    launchFailed: db.transaction((workerId: TaskWorkerId, message: string) => {
      end(workerId, "failed", message);
      db.query("UPDATE task_workers SET computer = 'unwanted' WHERE id = ?1 AND computer = 'wanted'").run(workerId);
    }),

    // Adds the worker's event number `index` to its turn, at `now`, while it sets
    // up or works. Each setup-step joins its setup; setup-done starts its work.
    // `done` ends the task: finished with the last message as the result, or
    // failed with the turn's error; blocked, with that error, while it still set
    // up. Null, storing nothing, for a repeat or another turn.
    appendTurnEvent: db.transaction((workerId: TaskWorkerId, turnId: TurnId, index: number, event: TurnEvent, now: number): ChatEvent | null => {
      if (!acceptEvent(db, "task_workers", "id = ?1 AND turn_id = ?2 AND state IN ('setting_up', 'working')", [workerId, turnId], index)) return null;
      touch(workerId);
      if (event.type === "approval-request") approvals.record(workerId, turnId, event, now);
      if (event.type === "approval-withdrawn") approvals.withdraw(workerId, event.approvalId);
      if (event.type === "setup-step") db.query("UPDATE task_workers SET setup = json_insert(setup, '$[#]', json(?2)) WHERE id = ?1").run(workerId, JSON.stringify(event.step));
      if (event.type === "setup-done") db.query("UPDATE task_workers SET state = 'working' WHERE id = ?1 AND state = 'setting_up'").run(workerId);
      const stored = append(workerId, event);
      if (event.type === "done") {
        const { state, result } = outcome(transcript(workerId));
        db.query("UPDATE task_workers SET state = CASE state WHEN 'setting_up' THEN 'blocked' ELSE ?2 END, result = ?3 WHERE id = ?1").run(workerId, state, result);
      }
      return stored;
    }),

    // Records a verifier's verdict, the first only: the push `revision` of its
    // branch when control pinned its commit, or null when it has one.
    setVerdict(workerId: TaskWorkerId, verdict: VerdictResult): { revision: number | null } | null {
      return db
        .query<{ revision: number | null }, [string, string]>("UPDATE task_workers SET verdict = ?2 WHERE id = ?1 AND verdict IS NULL RETURNING revision")
        .get(workerId, verdict);
    },

    // Ends the worker's turn from control's side (it was stopped, or lost the
    // turn): the events that end it, none when it was not running.
    end: db.transaction(end),

    // Stops the worker if it still runs, and marks its computer to go: a queued
    // worker never had one. The ending events.
    stop: db.transaction((workerId: TaskWorkerId, message: string): ChatEvent[] => {
      const queued = db.query("SELECT 1 FROM task_workers WHERE id = ?1 AND state = 'queued'").get(workerId) !== null;
      const ended = end(workerId, "stopped", message);
      db.query("UPDATE task_workers SET computer = ?3, updated_at = ?2 WHERE id = ?1 AND computer IN ('wanted', 'kept')").run(workerId, Date.now(), queued ? "removed" : "unwanted");
      return ended;
    }),

    // Workers the member asked for in the workspace's projects that have not ended.
    runningFor(workspaceId: WorkspaceId, userId: UserId): Array<{ workerId: TaskWorkerId; projectId: ProjectId }> {
      return db
        .query<{ id: string; project_id: string }, [string, string]>(
          `SELECT id, project_id FROM task_workers WHERE user_id = ?2 AND state IN (${unended})
           AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?1)`,
        )
        .all(workspaceId, userId)
        .map((row) => ({ workerId: TaskWorkerId.parse(row.id), projectId: ProjectId.parse(row.project_id) }));
    },

    // Workers of the project that have not ended (queued ones too), e.g. to stop them.
    running(projectId: ProjectId, taskNumber?: number): TaskWorkerId[] {
      return db
        .query<{ id: string }, [string, number | null]>(
          `SELECT id FROM task_workers WHERE project_id = ?1 AND state IN (${unended}) AND (?2 IS NULL OR task_number = ?2)`,
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

    // Workers whose turn ended (finished, blocked or failed) and whose computer
    // has not stopped yet: it should, keeping its disk until their task closes.
    ended(): TaskWorkerId[] {
      return db
        .query<{ id: string }, []>(`SELECT id FROM task_workers WHERE state IN (${ended}) AND computer = 'wanted'`)
        .all()
        .map((row) => TaskWorkerId.parse(row.id));
    },

    // Whether the worker's turn ended and its computer has yet to stop.
    stopPending: (workerId: TaskWorkerId) =>
      db.query(`SELECT 1 FROM task_workers WHERE id = ?1 AND state IN (${ended}) AND computer = 'wanted'`).get(workerId) !== null,

    // The provider stopped the ended worker's computer: it frees its place.
    computerStopped(workerId: TaskWorkerId) {
      db.query(`UPDATE task_workers SET computer = 'kept', updated_at = ?2 WHERE id = ?1 AND state IN (${ended}) AND computer = 'wanted'`).run(workerId, Date.now());
    },

    // Workers whose computer must go and may still exist: unwanted, or wanted or
    // kept by a task that is done or abandoned. With `projectId`, every computer of the project not yet removed.
    toReap(projectId?: ProjectId): TaskWorkerId[] {
      return db
        .query<{ id: string }, [string | null]>(
          `SELECT task_workers.id FROM ${withTask}
           WHERE CASE WHEN ?1 IS NULL THEN (${computerMustGo}) ELSE task_workers.project_id = ?1 AND task_workers.computer != 'removed' END`,
        )
        .all(projectId ?? null)
        .map((row) => TaskWorkerId.parse(row.id));
    },

    // Whether the worker's computer must go (as toReap's without a project).
    mustGo: (workerId: TaskWorkerId) => db.query(`SELECT 1 FROM ${withTask} WHERE task_workers.id = ?1 AND (${computerMustGo})`).get(workerId) !== null,

    // The provider deleted the worker's computer.
    computerRemoved(workerId: TaskWorkerId) {
      db.query("UPDATE task_workers SET computer = 'removed', updated_at = ?2 WHERE id = ?1").run(workerId, Date.now());
    },

    // The pull request the worker opened. Keeps the first.
    setPullRequest(workerId: TaskWorkerId, url: string) {
      db.query("UPDATE task_workers SET pull_request = COALESCE(pull_request, ?2), updated_at = ?3 WHERE id = ?1").run(workerId, url, Date.now());
    },

    // An approval control itself asks for (a push, a pull request or a connector
    // call) at `now`, recorded in the worker's turn like its own. Null unless that turn is working.
    requestApproval: db.transaction(
      (workerId: TaskWorkerId, turnId: TurnId, ask: { approvalId: ApprovalId; kind: ApprovalKind; detail: string }, now: number): ChatEvent | null => {
        const working = db.query("SELECT 1 FROM task_workers WHERE id = ?1 AND turn_id = ?2 AND state = 'working'").get(workerId, turnId);
        if (!working) return null;
        approvals.record(workerId, turnId, ask, now);
        touch(workerId);
        return append(workerId, { type: "approval-request", ...ask });
      },
    ),

    // Withdraws an approval control asked for the worker whose request went away
    // (approval-withdrawn in its turn). Null when it was not pending.
    withdrawApproval: db.transaction((workerId: TaskWorkerId, approvalId: ApprovalId): ChatEvent | null => {
      if (!approvals.withdraw(workerId, approvalId)) return null;
      touch(workerId);
      return append(workerId, { type: "approval-withdrawn", approvalId });
    }),

    // Records the requester's answer to one of the working worker's pending
    // approvals. Null, storing nothing, when there is no such pending approval.
    answerApproval: db.transaction((workerId: TaskWorkerId, approvalId: string, approved: boolean): ChatEvent | null => {
      const answered = approvals.answer(workerId, approvalId, approved);
      if (!answered) return null;
      touch(workerId);
      return append(workerId, { type: "approval-answer", approvalId: answered.approvalId, approved });
    }),

    // Every approval a working worker waits on, anywhere, with when it was asked:
    // control re-arms their wait limits when it starts.
    waitingApprovals: () =>
      approvals.waiting().map(({ ownerId, approvalId, requestedAt }) => ({ workerId: TaskWorkerId.parse(ownerId), approvalId, requestedAt })),

    // The answered approvals of the worker's turn, for a worker that may have missed the answers.
    answeredApprovals: (workerId: TaskWorkerId, turnId: TurnId) => approvals.answered(workerId, turnId),

    // Everything the worker's turn did so far, oldest first.
    transcript,

    // Continues the task of a worker whose turn ended by itself (finished,
    // blocked or failed), once per worker: queues `text` as a system turn for the
    // project's coordinator, in the chat of the member who requested the task,
    // behind any turn of theirs. Then that member and the turn's event. Once the
    // task had CONTINUATIONS_MAX, it needs that member instead: "used_up". Null
    // when nothing changed: the worker continued already or was stopped, its
    // task is done or abandoned, or the member left the workspace.
    continueTask: db.transaction((workerId: TaskWorkerId, text: string): { userId: UserId; event: ChatEvent } | "used_up" | null => {
      const row = db
        .query<{ project_id: string; task_number: number; status: string; requested_by: string }, [string]>(
          `SELECT task_workers.project_id, task_workers.task_number, project_tasks.status, project_tasks.requested_by FROM ${withTask}
           WHERE task_workers.id = ?1 AND task_workers.state IN (${ended})`,
        )
        .get(workerId);
      if (!row || !db.query("INSERT INTO task_continuations (worker_id) VALUES (?1) ON CONFLICT DO NOTHING RETURNING worker_id").get(workerId)) return null;
      const projectId = ProjectId.parse(row.project_id);
      const member = projects.member(projectId, { login: row.requested_by });
      if (row.status === "done" || row.status === "abandoned" || !member) return null;
      const queued = db
        .query<{ n: number }, [string, number]>(
          `SELECT count(*) AS n FROM task_continuations JOIN task_workers ON task_workers.id = task_continuations.worker_id
           WHERE task_workers.project_id = ?1 AND task_workers.task_number = ?2 AND task_continuations.turn_id IS NOT NULL`,
        )
        .get(projectId, row.task_number);
      if ((queued?.n ?? 0) >= CONTINUATIONS_MAX) {
        projects.updateTask(projectId, { number: row.task_number, status: "needs_input", question: STEPS_USED_UP });
        return "used_up";
      }
      const event = projects.queueSystemTurn(projectId, member.userId, text);
      db.query("UPDATE task_continuations SET turn_id = ?2 WHERE worker_id = ?1").run(workerId, event.turnId);
      return { userId: member.userId, event };
    }),

    // Workers whose turn ended by itself and that have not continued their task:
    // control stopped before they did.
    uncontinued(): TaskWorkerId[] {
      return db
        .query<{ id: string }, []>(
          `SELECT id FROM task_workers WHERE state IN (${ended}) AND id NOT IN (SELECT worker_id FROM task_continuations) ORDER BY updated_at, rowid`,
        )
        .all()
        .map((row) => TaskWorkerId.parse(row.id));
    },
  };
}

// How many turns a task's ended workers start for the coordinator on their own
// (continueTask). Past that, the task needs its requester: a loop of engineers
// and verifiers that never reaches done stops costing their Copilot.
export const CONTINUATIONS_MAX = 6;
export const STEPS_USED_UP = "Automatic steps used up: tell the project how to go on.";

// The states of workers that run, of those that have not ended yet, and of those
// whose turn ended by itself (a stopped worker's computer goes).
const running = "'launching', 'setting_up', 'working'";
const unended = `'queued', ${running}`;
const ended = "'finished', 'blocked', 'failed'";

// Workers with their task, and which of them have a computer that must go.
const withTask = `task_workers JOIN project_tasks
  ON project_tasks.project_id = task_workers.project_id AND project_tasks.number = task_workers.task_number`;
const computerMustGo = "task_workers.computer = 'unwanted' OR (task_workers.computer IN ('wanted', 'kept') AND project_tasks.status IN ('done', 'abandoned'))";

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
