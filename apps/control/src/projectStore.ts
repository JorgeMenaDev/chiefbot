import type { Database } from "bun:sqlite";
import {
  AUTO_MODEL,
  effectiveConfig,
  Project,
  ProjectFile,
  ProjectFileState,
  ProjectId,
  projectFileName,
  Task,
  TurnId,
  UserId,
  type ApprovalId,
  type ApprovalKind,
  type ChatEvent,
  type AutoFallback,
  CopilotPayer,
  type CreateTaskArgs,
  type DoneOverride,
  type ProjectMember,
  type ReasoningEffort,
  type TaskStatus,
  type TurnEvent,
  type UpdateTaskArgs,
  type Verification,
  type WorkspaceId,
} from "@chiefbot/contracts";
import { z } from "zod";
import { addColumn } from "./addColumn.ts";
import { issuesOf, parseProjectFile } from "./projectFile.ts";
import { acceptEvent, approvalRecords, toChatEvent, type ChatEventRow } from "./turnRecords.ts";

// Projects, their task ledgers and their members' chats with the coordinator,
// in control's SQLite. openStore (store.ts) calls this once the users and
// workspaces tables exist. Methods that take an id from a URL accept a plain
// string: an unknown one reads as missing.
export function projectStore(db: Database, hash: (token: string) => string) {
  // A project binds one repo of a workspace. `file` is what control found of its
  // chiefbot.project.yaml (a ProjectFileState) as JSON, and `settings` the YAML
  // members saved in the app. The coordinator's credential is stored as a SHA-256.
  db.run(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    repo TEXT NOT NULL COLLATE NOCASE,
    file TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, repo)
  )`);
  addColumn(db, "projects", "settings", "TEXT NOT NULL DEFAULT ''");
  // The coordinator's Copilot model id, and its reasoning effort (NULL: the
  // model's default). Projects from before the model picker run on Auto.
  addColumn(db, "projects", "model", `TEXT NOT NULL DEFAULT '${AUTO_MODEL}'`);
  addColumn(db, "projects", "effort", "TEXT");
  // The project's secrets that control holds a value for, each with the
  // SecretStore name its value is under. Each value written gets a new one.
  db.run(`CREATE TABLE IF NOT EXISTS project_secrets (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    secret_name TEXT NOT NULL,
    PRIMARY KEY (project_id, name)
  )`);
  // SecretStore names that may hold a value no project secret uses: a value
  // being written, one whose write failed, a replaced or cleared one, a deleted
  // project's. Each stays until the SecretStore deleted it, even past its project.
  db.run("CREATE TABLE IF NOT EXISTS project_secret_leftovers (secret_name TEXT PRIMARY KEY)");
  // The task ledger: the only record of task state. `links` is a JSON array of TaskLinks.
  db.run(`CREATE TABLE IF NOT EXISTS project_tasks (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'needs_input', 'done', 'abandoned')),
    owner TEXT,
    requested_by TEXT NOT NULL,
    links TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, number)
  )`);
  // What the task waits on while it needs input; NULL otherwise.
  addColumn(db, "project_tasks", "question", "TEXT");
  // Its latest verdict from a verifier, a Verification as JSON; NULL before any.
  // `overrides`: a JSON array of DoneOverrides, each time a member marked it done in the app.
  addColumn(db, "project_tasks", "verification", "TEXT");
  addColumn(db, "project_tasks", "overrides", "TEXT NOT NULL DEFAULT '[]'");
  // Each member's chat with the coordinator: turns and their events, as for a
  // bot's chat. A turn waits `queued` until the project's scheduler gives it
  // the coordinator; at most one turn per project is `running`.
  db.run(`CREATE TABLE IF NOT EXISTS coordinator_turns (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done')),
    next_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS coordinator_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES coordinator_turns(id) ON DELETE CASCADE,
    event TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS coordinator_events_by_chat ON coordinator_events (project_id, user_id, seq)");
  // Who pays for the turn (JSON CopilotPayer), from when the scheduler starts it. NULL before, and for turns started before the column.
  addColumn(db, "coordinator_turns", "payer", "TEXT");
  // What control asked the member of a coordinator turn to approve (a connector
  // call, connectors.ts), and the answer (NULL while pending) (turnRecords.ts approvalRecords).
  db.run(`CREATE TABLE IF NOT EXISTS coordinator_approvals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES coordinator_turns(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    approved INTEGER
  )`);
  const approvals = approvalRecords(db, {
    table: "coordinator_approvals",
    owner: "project_id",
    liveTurns: "SELECT id FROM coordinator_turns WHERE state = 'running'",
  });

  // Records the SecretStore names `select` finds as leftovers, and returns them.
  const retire = (select: string, ...params: string[]) => {
    const names = db
      .query<{ secret_name: string }, string[]>(select)
      .all(...params)
      .map(({ secret_name }) => secret_name);
    for (const name of names) db.query("INSERT OR IGNORE INTO project_secret_leftovers (secret_name) VALUES (?1)").run(name);
    return names;
  };

  type ProjectRow = { id: string; workspace_id: string; name: string; repo: string; file: string; settings: string; model: string; effort: string | null };
  // What control stored of the project file. Projects made before a missing
  // file was allowed store the file itself, and those made before `environments`
  // left the project file (it was never used) still carry it: it is dropped.
  const LegacyFile = ProjectFile.extend({ environments: z.unknown().optional() }).transform(({ environments: _, ...file }) => ({ status: "found" as const, file }));
  // A file stored before the project file's rules changed may no longer fit
  // them: it reads as invalid, so the project still opens and its settings take over.
  const storedFile = (json: string): ProjectFileState => {
    const stored: unknown = JSON.parse(json);
    const file = (typeof stored === "object" && stored !== null && "status" in stored ? ProjectFileState : LegacyFile).safeParse(stored);
    return file.success ? file.data : { status: "invalid", error: `${projectFileName}, as read when the project was made: ${issuesOf(file.error)}` };
  };
  // Settings are checked when saved (PUT /projects/:id/settings), so they parse here.
  const storedSettings = (text: string) => {
    const settings = parseProjectFile(text);
    if ("error" in settings) throw new Error(`stored project settings no longer parse: ${settings.error}`);
    return settings;
  };
  const toProject = (row: ProjectRow): Project => {
    const file = storedFile(row.file);
    const { config, sources } = effectiveConfig(file.status === "found" ? file.file : null, storedSettings(row.settings));
    const { id, workspace_id: workspaceId, name, repo, settings, model, effort } = row;
    return Project.parse({ id, workspaceId, name, repo, file, settings, config, sources, model, effort });
  };
  const projectColumns = "projects.id, projects.workspace_id, projects.name, projects.repo, projects.file, projects.settings, projects.model, projects.effort";
  const returnedColumns = "RETURNING id, workspace_id, name, repo, file, settings, model, effort";

  type TaskRow = {
    project_id: string;
    number: number;
    title: string;
    detail: string;
    status: string;
    question: string | null;
    owner: string | null;
    requested_by: string;
    links: string;
    verification: string | null;
    overrides: string;
    created_at: number;
    updated_at: number;
  };
  const toTask = (row: TaskRow): Task =>
    Task.parse({
      projectId: row.project_id,
      number: row.number,
      title: row.title,
      detail: row.detail,
      status: row.status,
      question: row.question,
      owner: row.owner,
      requestedBy: row.requested_by,
      links: JSON.parse(row.links),
      verification: row.verification === null ? null : JSON.parse(row.verification),
      overrides: JSON.parse(row.overrides),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  const task = (projectId: ProjectId, number: number) => {
    const row = db.query<TaskRow, [string, number]>("SELECT * FROM project_tasks WHERE project_id = ?1 AND number = ?2").get(projectId, number);
    return row ? toTask(row) : null;
  };

  // Stores one event of a turn in its member's chat.
  const append = (turnId: TurnId, event: ChatEvent["event"]) => {
    const row = db
      .query<ChatEventRow, [string, string]>(
        `INSERT INTO coordinator_events (project_id, user_id, turn_id, event)
         SELECT project_id, user_id, id, ?2 FROM coordinator_turns WHERE id = ?1 RETURNING seq, turn_id, event`,
      )
      .get(turnId, JSON.stringify(event));
    if (!row) throw new Error("coordinator event insert returned no row");
    return toChatEvent(row);
  };

  // A stored chat event and the member whose chat it is in.
  type MemberEvent = { userId: UserId; event: ChatEvent };

  const userOfTurn = (turnId: TurnId) => {
    const row = db.query<{ user_id: string }, [string]>("SELECT user_id FROM coordinator_turns WHERE id = ?1").get(turnId);
    if (!row) throw new Error(`no coordinator turn ${turnId}`);
    return UserId.parse(row.user_id);
  };

  return {
    // A new project named after its repo, or "exists" when the workspace already
    // has one for the repo. `token` is the coordinator's credential.
    create(workspaceId: WorkspaceId, repo: string, file: ProjectFileState, token: string): Project | "exists" {
      const row = db
        .query<ProjectRow, [string, string, string, string, string, string, number]>(
          `INSERT INTO projects (id, workspace_id, name, repo, file, token_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT (workspace_id, repo) DO NOTHING ${returnedColumns}`,
        )
        .get(`project_${crypto.randomUUID()}`, workspaceId, repo.split("/")[1] ?? repo, repo, JSON.stringify(file), hash(token), Date.now());
      return row ? toProject(row) : "exists";
    },

    projectsIn(workspaceId: WorkspaceId): Project[] {
      return db
        .query<ProjectRow, [string]>(`SELECT ${projectColumns} FROM projects WHERE workspace_id = ?1 ORDER BY created_at, id`)
        .all(workspaceId)
        .map(toProject);
    },

    // The project, if the user is a member of its workspace, with their role there.
    projectFor(userId: UserId, projectId: string) {
      const row = db
        .query<ProjectRow & { role: string }, [string, string]>(
          `SELECT ${projectColumns}, workspace_members.role FROM projects
           JOIN workspace_members ON workspace_members.workspace_id = projects.workspace_id
           WHERE workspace_members.user_id = ?1 AND projects.id = ?2`,
        )
        .get(userId, projectId);
      return row ? { project: toProject(row), owner: row.role === "owner" } : null;
    },

    project(projectId: ProjectId): Project | null {
      const row = db.query<ProjectRow, [string]>(`SELECT ${projectColumns} FROM projects WHERE id = ?1`).get(projectId);
      return row ? toProject(row) : null;
    },

    // The project a coordinator credential belongs to.
    projectForToken(token: string): ProjectId | null {
      const row = db.query<{ id: string }, [string]>("SELECT id FROM projects WHERE token_hash = ?1").get(hash(token));
      return row ? ProjectId.parse(row.id) : null;
    },

    // Deletes the project; returns the SecretStore names of its secrets' values, now leftovers.
    delete(projectId: ProjectId): string[] {
      return db.transaction(() => {
        const held = retire("SELECT secret_name FROM project_secrets WHERE project_id = ?1", projectId);
        db.query("DELETE FROM projects WHERE id = ?1").run(projectId);
        return held;
      })();
    },

    // The names of the project's secrets control holds a value for, oldest first.
    secretNames(projectId: ProjectId): string[] {
      return db
        .query<{ name: string }, [string]>("SELECT name FROM project_secrets WHERE project_id = ?1 ORDER BY rowid")
        .all(projectId)
        .map(({ name }) => name);
    },

    // The project's secrets that control holds a value for, each with the SecretStore name of its value.
    secretRefs(projectId: ProjectId): Array<{ name: string; secretName: string }> {
      return db
        .query<{ name: string; secret_name: string }, [string]>("SELECT name, secret_name FROM project_secrets WHERE project_id = ?1 ORDER BY rowid")
        .all(projectId)
        .map(({ name, secret_name }) => ({ name, secretName: secret_name }));
    },

    // A value is about to be written under `secretName`: a leftover until it is published.
    stageSecret(secretName: string) {
      db.query("INSERT OR IGNORE INTO project_secret_leftovers (secret_name) VALUES (?1)").run(secretName);
    },

    // The project's secret `name` now has the value written under
    // `secretName`; returns the SecretStore name of the value it replaced, now a leftover.
    publishSecret(projectId: ProjectId, name: string, secretName: string): string[] {
      return db.transaction(() => {
        const replaced = retire("SELECT secret_name FROM project_secrets WHERE project_id = ?1 AND name = ?2", projectId, name);
        db.query(
          `INSERT INTO project_secrets (project_id, name, secret_name) VALUES (?1, ?2, ?3)
           ON CONFLICT (project_id, name) DO UPDATE SET secret_name = excluded.secret_name`,
        ).run(projectId, name, secretName);
        db.query("DELETE FROM project_secret_leftovers WHERE secret_name = ?1").run(secretName);
        return replaced;
      })();
    },

    // The project's secret `name` has no value any more; returns the SecretStore name of the one it had, now a leftover.
    clearSecret(projectId: ProjectId, name: string): string[] {
      return db.transaction(() => {
        const cleared = retire("SELECT secret_name FROM project_secrets WHERE project_id = ?1 AND name = ?2", projectId, name);
        db.query("DELETE FROM project_secrets WHERE project_id = ?1 AND name = ?2").run(projectId, name);
        return cleared;
      })();
    },

    // Every leftover SecretStore name, and the end of one the SecretStore deleted.
    secretLeftovers: () =>
      db
        .query<{ secret_name: string }, []>("SELECT secret_name FROM project_secret_leftovers")
        .all()
        .map(({ secret_name }) => secret_name),
    secretDeleted(secretName: string) {
      db.query("DELETE FROM project_secret_leftovers WHERE secret_name = ?1").run(secretName);
    },

    // Saves the project's settings, YAML its caller has checked (parseProjectFile).
    setSettings(projectId: ProjectId, text: string): Project | null {
      const row = db
        .query<ProjectRow, [string, string]>(`UPDATE projects SET settings = ?2 WHERE id = ?1 ${returnedColumns}`)
        .get(projectId, text);
      return row ? toProject(row) : null;
    },

    // The coordinator's turns run on `model` at `effort` from the next one on.
    setModel(projectId: ProjectId, model: string, effort: ReasoningEffort | null): Project | null {
      const row = db
        .query<ProjectRow, [string, string, string | null]>(`UPDATE projects SET model = ?2, effort = ?3 WHERE id = ?1 ${returnedColumns}`)
        .get(projectId, model, effort);
      return row ? toProject(row) : null;
    },

    // The project's workspace members: who sees its ledger.
    memberIds(projectId: ProjectId): UserId[] {
      return db
        .query<{ user_id: string }, [string]>(
          `SELECT workspace_members.user_id FROM workspace_members JOIN projects ON projects.workspace_id = workspace_members.workspace_id
           WHERE projects.id = ?1`,
        )
        .all(projectId)
        .map((row) => UserId.parse(row.user_id));
    },

    // A member of the project's workspace, by user id or GitHub login; null for anyone else.
    member(projectId: ProjectId, who: { userId: string } | { login: string }): ProjectMember | null {
      const [column, value] = "userId" in who ? ["users.id", who.userId] : ["users.login", who.login];
      const row = db
        .query<{ id: string; login: string }, [string, string]>(
          `SELECT users.id, users.login FROM users JOIN workspace_members ON workspace_members.user_id = users.id
           JOIN projects ON projects.workspace_id = workspace_members.workspace_id
           WHERE projects.id = ?1 AND ${column} = ?2 COLLATE NOCASE`,
        )
        .get(projectId, value);
      return row ? { userId: UserId.parse(row.id), login: row.login } : null;
    },

    // The project's tasks, oldest first; only those with `statuses` when given.
    tasks(projectId: ProjectId, statuses?: TaskStatus[]): Task[] {
      return db
        .query<TaskRow, [string]>("SELECT * FROM project_tasks WHERE project_id = ?1 ORDER BY number")
        .all(projectId)
        .map(toTask)
        .filter(({ status }) => !statuses || statuses.includes(status));
    },

    // A new open task with the project's next number. `owner` is a member's login, checked by the caller.
    createTask: db.transaction((projectId: ProjectId, { title, detail, owner }: z.output<typeof CreateTaskArgs>, requestedBy: string): Task => {
      const now = Date.now();
      const row = db
        .query<TaskRow, [string, string, string, string | null, string, number]>(
          `INSERT INTO project_tasks (project_id, number, title, detail, status, owner, requested_by, links, created_at, updated_at)
           VALUES (?1, (SELECT COALESCE(MAX(number), 0) + 1 FROM project_tasks WHERE project_id = ?1), ?2, ?3, 'open', ?4, ?5, '[]', ?6, ?6)
           RETURNING *`,
        )
        .get(projectId, title, detail, owner, requestedBy, now);
      if (!row) throw new Error("task insert returned no row");
      return toTask(row);
    }),

    // Changes the fields given and adds `links`. A question stays while the task
    // needs input, and goes once it does not. Null when the project has no such task.
    updateTask: db.transaction((projectId: ProjectId, { number, links, ...change }: z.output<typeof UpdateTaskArgs>): Task | null => {
      const current = task(projectId, number);
      if (!current) return null;
      const status = change.status ?? current.status;
      const next = {
        title: change.title ?? current.title,
        detail: change.detail ?? current.detail,
        status,
        question: status === "needs_input" ? (change.question ?? current.question) : null,
        owner: change.owner === undefined ? current.owner : change.owner,
        links: [...current.links, ...(links ?? [])],
      };
      db.query(
        `UPDATE project_tasks SET title = ?3, detail = ?4, status = ?5, question = ?6, owner = ?7, links = ?8, updated_at = ?9
         WHERE project_id = ?1 AND number = ?2`,
      ).run(projectId, number, next.title, next.detail, next.status, next.question, next.owner, JSON.stringify(next.links), Date.now());
      return task(projectId, number);
    }),

    // A member (`by`, a login) marks the task done in the app: recorded on it
    // with its verification then. "closed" when it is done or abandoned; null
    // when the project has no such task.
    markDone: db.transaction((projectId: ProjectId, number: number, by: string): Task | "closed" | null => {
      const current = task(projectId, number);
      if (!current) return null;
      if (current.status === "done" || current.status === "abandoned") return "closed";
      const now = Date.now();
      const overrides = [...current.overrides, { by, at: now, verification: current.verification } satisfies DoneOverride];
      db.query("UPDATE project_tasks SET status = 'done', question = NULL, overrides = ?3, updated_at = ?4 WHERE project_id = ?1 AND number = ?2").run(
        projectId,
        number,
        JSON.stringify(overrides),
        now,
      );
      return task(projectId, number);
    }),

    // Sets the task's latest verdict. Null when the project has no such task.
    setVerification(projectId: ProjectId, number: number, verification: Verification): Task | null {
      db.query("UPDATE project_tasks SET verification = ?3, updated_at = ?4 WHERE project_id = ?1 AND number = ?2").run(
        projectId,
        number,
        JSON.stringify(verification),
        Date.now(),
      );
      return task(projectId, number);
    },

    // A push moved branches of `repo` (each to its `sha`): marks stale each
    // verification of the repo's tasks on one of them at another commit. The
    // projects whose tasks changed.
    staleOnPush: db.transaction((repo: string, moved: Array<{ branch: string; sha: string }>): ProjectId[] => {
      const verified = db
        .query<TaskRow, [string]>(
          `SELECT project_tasks.* FROM project_tasks JOIN projects ON projects.id = project_tasks.project_id
           WHERE projects.repo = ?1 AND project_tasks.verification IS NOT NULL`,
        )
        .all(repo)
        .map(toTask);
      const changed = new Set<ProjectId>();
      for (const { projectId, number, verification } of verified) {
        if (!verification || verification.stale || !moved.some(({ branch, sha }) => branch === verification.branch && sha !== verification.sha)) continue;
        db.query("UPDATE project_tasks SET verification = ?3, updated_at = ?4 WHERE project_id = ?1 AND number = ?2").run(
          projectId,
          number,
          JSON.stringify({ ...verification, stale: true } satisfies Verification),
          Date.now(),
        );
        changed.add(projectId);
      }
      return [...changed];
    }),

    // Queues a member's message for the coordinator. Null, storing nothing, while
    // their previous message is still queued or running, unless `whileBusy`: a
    // handoff from the member's chief of staff queues behind it instead.
    queueTurn: db.transaction((projectId: ProjectId, userId: UserId, text: string, whileBusy = false): ChatEvent | null => {
      const unfinished = db
        .query("SELECT 1 FROM coordinator_turns WHERE project_id = ?1 AND user_id = ?2 AND state != 'done'")
        .get(projectId, userId);
      if (unfinished && !whileBusy) return null;
      const turnId = TurnId.parse(`turn_${crypto.randomUUID()}`);
      db.query(
        "INSERT INTO coordinator_turns (id, project_id, user_id, text, state, created_at) VALUES (?1, ?2, ?3, ?4, 'queued', ?5)",
      ).run(turnId, projectId, userId, text, Date.now());
      return append(turnId, { type: "user-message", text });
    }),

    // The scheduler's one claim: the project's oldest queued turn becomes its
    // running turn. Null while a turn is running or none waits, so the
    // coordinator never runs two turns of one project at once.
    claimNextTurn: db.transaction((projectId: ProjectId) => {
      const running = db.query("SELECT 1 FROM coordinator_turns WHERE project_id = ?1 AND state = 'running'").get(projectId);
      if (running) return null;
      const row = db
        .query<{ id: string; text: string; user_id: string; login: string }, [string]>(
          `UPDATE coordinator_turns SET state = 'running'
           WHERE id = (SELECT id FROM coordinator_turns WHERE project_id = ?1 AND state = 'queued' ORDER BY created_at, rowid LIMIT 1)
           RETURNING id, text, user_id, (SELECT login FROM users WHERE users.id = user_id) AS login`,
        )
        .get(projectId);
      return row
        ? { turnId: TurnId.parse(row.id), text: row.text, member: { userId: UserId.parse(row.user_id), login: row.login } }
        : null;
    }),

    // Records who pays for the turn, and says so in its chat, with why it runs
    // on Auto when it does. Outside the coordinator's numbering.
    addPayer: db.transaction((turnId: TurnId, payer: CopilotPayer, fallback: AutoFallback | null): MemberEvent => {
      db.query("UPDATE coordinator_turns SET payer = ?2 WHERE id = ?1").run(turnId, JSON.stringify(payer));
      return { userId: userOfTurn(turnId), event: append(turnId, { type: "payer", payer, fallback }) };
    }),

    // Whether a turn waits for the project's coordinator.
    hasQueuedTurn(projectId: ProjectId): boolean {
      return db.query("SELECT 1 FROM coordinator_turns WHERE project_id = ?1 AND state = 'queued'").get(projectId) !== null;
    },

    // Whether a turn of the project runs or waits for its coordinator.
    hasUnfinishedTurn(projectId: ProjectId): boolean {
      return db.query("SELECT 1 FROM coordinator_turns WHERE project_id = ?1 AND state != 'done'").get(projectId) !== null;
    },

    // Who pays for the project's turn, as recorded when it started, while it runs; null otherwise.
    runningTurnPayer(projectId: ProjectId, turnId: TurnId): CopilotPayer | null {
      const row = db
        .query<{ payer: string | null }, [string, string]>("SELECT payer FROM coordinator_turns WHERE id = ?1 AND project_id = ?2 AND state = 'running'")
        .get(turnId, projectId);
      return row?.payer ? CopilotPayer.parse(JSON.parse(row.payer)) : null;
    },

    // The member the project's turn runs for, while it runs; null otherwise.
    runningTurnMember(projectId: ProjectId, turnId: TurnId): UserId | null {
      const row = db
        .query<{ user_id: string }, [string, string]>("SELECT user_id FROM coordinator_turns WHERE id = ?1 AND project_id = ?2 AND state = 'running'")
        .get(turnId, projectId);
      return row ? UserId.parse(row.user_id) : null;
    },

    // The member left the workspace or was removed: their queued turns in its
    // projects go, and their running one ends. The events that end it, to publish.
    dropMember: db.transaction((workspaceId: WorkspaceId, userId: UserId): Array<MemberEvent & { projectId: ProjectId }> => {
      const inWorkspace = "project_id IN (SELECT id FROM projects WHERE workspace_id = ?1) AND user_id = ?2";
      db.query(`DELETE FROM coordinator_turns WHERE ${inWorkspace} AND state = 'queued'`).run(workspaceId, userId);
      const ended = db
        .query<{ id: string; project_id: string }, [string, string]>(
          `UPDATE coordinator_turns SET state = 'done' WHERE ${inWorkspace} AND state = 'running' RETURNING id, project_id`,
        )
        .all(workspaceId, userId);
      return ended.flatMap(({ id, project_id }) => {
        const turnId = TurnId.parse(id);
        const projectId = ProjectId.parse(project_id);
        return [
          { projectId, userId, event: append(turnId, { type: "error", message: "You are no longer a member of this workspace." }) },
          { projectId, userId, event: append(turnId, { type: "done" }) },
        ];
      });
    }),

    // Adds the coordinator's event number `index` to the project's running turn;
    // `done` finishes it. Null, storing nothing, for a repeat or any other turn.
    appendTurnEvent: db.transaction((projectId: ProjectId, turnId: TurnId, index: number, event: TurnEvent): MemberEvent | null => {
      if (!acceptEvent(db, "coordinator_turns", "id = ?1 AND project_id = ?2 AND state = 'running'", [turnId, projectId], index)) return null;
      if (event.type === "done") db.query("UPDATE coordinator_turns SET state = 'done' WHERE id = ?1").run(turnId);
      return { userId: userOfTurn(turnId), event: append(turnId, event) };
    }),

    // An approval control asks for in a running coordinator turn (a connector
    // call), recorded in its member's chat. Null when that turn is not running.
    requestApproval: db.transaction((turnId: TurnId, ask: { approvalId: ApprovalId; kind: ApprovalKind; detail: string }): MemberEvent | null => {
      const turn = db
        .query<{ project_id: string; user_id: string }, [string]>("SELECT project_id, user_id FROM coordinator_turns WHERE id = ?1 AND state = 'running'")
        .get(turnId);
      if (!turn) return null;
      approvals.record(turn.project_id, turnId, ask, Date.now());
      return { userId: UserId.parse(turn.user_id), event: append(turnId, { type: "approval-request", ...ask }) };
    }),

    // Records the member's answer to a pending approval of their running turn.
    // Null, storing nothing, when there is no such pending approval for them.
    answerApproval: db.transaction((projectId: ProjectId, userId: UserId, approvalId: string, approved: boolean): MemberEvent | null => {
      const turnId = approvals.pendingTurn(projectId, approvalId);
      const answered = turnId && userOfTurn(turnId) === userId ? approvals.answer(projectId, approvalId, approved) : null;
      return answered && { userId, event: append(answered.turnId, { type: "approval-answer", approvalId: answered.approvalId, approved }) };
    }),

    // Ends the project's running turn unless it is `keep`: the coordinator lost it.
    abandonRunningTurn: db.transaction((projectId: ProjectId, keep: TurnId | null, message: string): MemberEvent[] => {
      const row = db
        .query<{ id: string; user_id: string }, [string, string]>(
          "UPDATE coordinator_turns SET state = 'done' WHERE project_id = ?1 AND state = 'running' AND id != ?2 RETURNING id, user_id",
        )
        .get(projectId, keep ?? "");
      if (!row) return [];
      const turnId = TurnId.parse(row.id);
      const userId = UserId.parse(row.user_id);
      return [
        { userId, event: append(turnId, { type: "error", message }) },
        { userId, event: append(turnId, { type: "done" }) },
      ];
    }),

    // The coordinator's last message in the latest of `turnIds` that has one and
    // is done; null when none has.
    lastReply(turnIds: readonly TurnId[]): string | null {
      const events = db
        .query<ChatEventRow, [string]>(
          `SELECT seq, turn_id, event FROM coordinator_events
           WHERE turn_id IN (SELECT id FROM coordinator_turns WHERE state = 'done' AND id IN (SELECT value FROM json_each(?1)))
           ORDER BY seq`,
        )
        .all(JSON.stringify(turnIds))
        .map(toChatEvent);
      const last = events.findLast(({ event }) => event.type === "text-delta");
      if (last?.event.type !== "text-delta") return null;
      const { turnId, event: { messageId } } = last;
      return events
        .flatMap(({ turnId: id, event }) => (id === turnId && event.type === "text-delta" && event.messageId === messageId ? [event.text] : []))
        .join("");
    },

    // The member's chat with the project's coordinator after `seq` (0 for all of it), oldest first.
    chatAfter(projectId: ProjectId, userId: UserId, seq: number): ChatEvent[] {
      return db
        .query<ChatEventRow, [string, string, number]>(
          "SELECT seq, turn_id, event FROM coordinator_events WHERE project_id = ?1 AND user_id = ?2 AND seq > ?3 ORDER BY seq",
        )
        .all(projectId, userId, seq)
        .map(toChatEvent);
    },
  };
}
