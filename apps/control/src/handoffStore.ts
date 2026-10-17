import type { Database } from "bun:sqlite";
import {
  Handoff,
  HandoffId,
  BotId,
  type ChatEvent,
  type HandoffUpdate,
  type ProjectId,
  type SendToProjectArgs,
  type TaskLink,
  type UserId,
} from "@chiefbot/contracts";
import type { z } from "zod";
import type { projectStore } from "./projectStore.ts";

// What chiefs of staff handed to projects, in control's SQLite. openStore
// (store.ts) calls this once the bots and project tables exist. `postNotice`
// stores a note in a bot's chat, in a turn of its own.
export function handoffStore(
  db: Database,
  projects: ReturnType<typeof projectStore>,
  postNotice: (botId: BotId, notice: HandoffUpdate) => ChatEvent,
) {
  // One handoff of a bot (its owner's chief of staff) to a project: the request
  // and the ledger task it became. The task is the only record of its status;
  // `watched_status` is its status as the watcher last saw it.
  db.run(`CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    task_number INTEGER NOT NULL,
    request TEXT NOT NULL,
    acceptance TEXT NOT NULL,
    watched_status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (project_id, task_number) REFERENCES project_tasks (project_id, number) ON DELETE CASCADE
  )`);

  type HandoffRow = {
    id: string;
    project_id: string;
    project: string;
    title: string;
    requested_by: string;
    request: string;
    acceptance: string;
    task_number: number;
    status: string;
    links: string;
    created_at: number;
  };
  // A handoff with its task's status and links, while the requester is still a
  // member of the project's workspace: a chief sees no project its owner left.
  const select = `SELECT handoffs.id, handoffs.project_id, projects.name AS project, project_tasks.title, users.login AS requested_by,
      handoffs.request, handoffs.acceptance, handoffs.task_number, project_tasks.status, project_tasks.links, handoffs.created_at
    FROM handoffs
    JOIN projects ON projects.id = handoffs.project_id
    JOIN project_tasks ON project_tasks.project_id = handoffs.project_id AND project_tasks.number = handoffs.task_number
    JOIN users ON users.id = handoffs.user_id
    JOIN workspace_members ON workspace_members.workspace_id = projects.workspace_id AND workspace_members.user_id = handoffs.user_id`;
  const toHandoff = (row: HandoffRow): Handoff =>
    Handoff.parse({
      id: row.id,
      projectId: row.project_id,
      project: row.project,
      title: row.title,
      requestedBy: row.requested_by,
      request: row.request,
      acceptance: row.acceptance,
      taskNumber: row.task_number,
      status: row.status,
      links: JSON.parse(row.links),
      createdAt: row.created_at,
    });
  const byId = (handoffId: string) => {
    const row = db.query<HandoffRow, [string]>(`${select} WHERE handoffs.id = ?1`).get(handoffId);
    return row ? toHandoff(row) : null;
  };

  return {
    // The bot's handoff to the project: a new open task in its ledger, requested
    // by the bot's owner. The caller checked that the owner is a member.
    create: db.transaction(
      (botId: BotId, owner: { userId: UserId; login: string }, projectId: ProjectId, args: z.output<typeof SendToProjectArgs>): Handoff => {
        const detail = `${args.request}\n\nDone when: ${args.acceptance}`;
        const task = projects.createTask(projectId, { title: args.title, detail, owner: null }, owner.login);
        const id = HandoffId.parse(`handoff_${crypto.randomUUID()}`);
        db.query(
          `INSERT INTO handoffs (id, bot_id, user_id, project_id, task_number, request, acceptance, watched_status, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        ).run(id, botId, owner.userId, projectId, task.number, args.request, args.acceptance, task.status, Date.now());
        const handoff = byId(id);
        if (!handoff) throw new Error("handoff insert returned no row");
        return handoff;
      },
    ),

    // The watcher, run after every change to the project's ledger, and for every
    // project (no `projectId`) when control starts, for a change whose watch a
    // crash cut short: each handoff whose task's status changed since it last
    // looked, and became needs_input or done, gets one notice in its chief's
    // chat. A repeat of the same status changes nothing, so it posts nothing.
    // Returns the notices, to publish.
    watch: db.transaction((projectId?: ProjectId): Array<{ botId: BotId; event: ChatEvent }> => {
      const changed = db
        .query<{ id: string; bot_id: string }, [string | null]>(
          `UPDATE handoffs SET watched_status = project_tasks.status FROM project_tasks
           WHERE (?1 IS NULL OR handoffs.project_id = ?1) AND project_tasks.project_id = handoffs.project_id
             AND project_tasks.number = handoffs.task_number AND project_tasks.status != handoffs.watched_status
           RETURNING handoffs.id, handoffs.bot_id`,
        )
        .all(projectId ?? null);
      return changed.flatMap(({ id, bot_id }) => {
        // Null once the owner has left the project's workspace: their chief hears no more.
        const handoff = byId(id);
        if (handoff?.status !== "needs_input" && handoff?.status !== "done") return [];
        const botId = BotId.parse(bot_id);
        return [{ botId, event: postNotice(botId, { type: "handoff-update", handoffId: handoff.id, status: handoff.status, text: notice(handoff) }) }];
      });
    }),

    // The bot's handoffs, oldest first; only `handoffId` when given.
    of(botId: BotId, handoffId?: HandoffId): Handoff[] {
      return db
        .query<HandoffRow, [string, string | null]>(
          `${select} WHERE handoffs.bot_id = ?1 AND (?2 IS NULL OR handoffs.id = ?2) ORDER BY handoffs.created_at, handoffs.rowid`,
        )
        .all(botId, handoffId ?? null)
        .map(toHandoff);
    },
  };
}

// What the chief's owner reads when the project needs them or is done.
function notice({ project, title, taskNumber, status, links }: Handoff) {
  const task = `"${title}" (task #${taskNumber})`;
  if (status === "needs_input") return `${project} needs your input on ${task}. Answer in the project's chat.`;
  return links.length === 0 ? `${project} finished ${task}.` : `${project} finished ${task}: ${links.map(linkText).join(", ")}`;
}

const linkText = (link: TaskLink) => (link.kind === "context" ? link.path : link.url);
