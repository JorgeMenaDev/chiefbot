import type { Database } from "bun:sqlite";
import {
  Handoff,
  HandoffId,
  BotId,
  ProjectId,
  TurnId,
  UserId,
  HandoffCard,
  TaskLink,
  TaskStatus,
  VerdictLine,
  Verification,
  currentVerification,
  type ChatEvent,
  type HandoffCardEvent,
  type HandoffStage,
  type SendToProjectArgs,
} from "@chiefbot/contracts";
import type { z } from "zod";
import { addColumn } from "./addColumn.ts";
import type { projectStore } from "./projectStore.ts";
import type { taskWorkerStore } from "./taskWorkerStore.ts";

// What chiefs of staff handed to projects, in control's SQLite. openStore
// (store.ts) calls this once the bots, project and task worker tables exist.
// `postCard` stores a handoff's card in a bot's chat, in a turn of its own.
export function handoffStore(
  db: Database,
  projects: ReturnType<typeof projectStore>,
  workers: ReturnType<typeof taskWorkerStore>,
  postCard: (botId: BotId, card: HandoffCardEvent) => ChatEvent,
) {
  // One handoff of a bot (its owner's chief of staff) to a project: the request
  // and the ledger task it became. The task is the only record of its status.
  // `watched_card` is the card last posted in the chief's chat, as JSON: '' until
  // the first, NULL for a handoff from before cards until the watcher looks.
  db.run(`CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    task_number INTEGER NOT NULL,
    request TEXT NOT NULL,
    acceptance TEXT NOT NULL,
    watched_card TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (project_id, task_number) REFERENCES project_tasks (project_id, number) ON DELETE CASCADE
  )`);
  // Handoffs from before cards watched only their task's status.
  addColumn(db, "handoffs", "watched_card", "TEXT");
  if (db.query("SELECT 1 FROM pragma_table_info('handoffs') WHERE name = 'watched_status'").get()) {
    db.run("ALTER TABLE handoffs DROP COLUMN watched_status");
  }
  // Each message a handoff delivered to the coordinator: the request ('request')
  // and every follow-up, by its delivery id, with the question it answered (if
  // any) and the coordinator turn it queued. A delivery id seen before delivers
  // nothing, and takes no other message or question.
  db.run(`CREATE TABLE IF NOT EXISTS handoff_messages (
    handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
    delivery_id TEXT NOT NULL,
    message TEXT NOT NULL,
    question TEXT,
    turn_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (handoff_id, delivery_id)
  )`);

  type HandoffRow = {
    id: string;
    bot_id: string;
    workspace_id: string;
    project_id: string;
    project: string;
    title: string;
    requested_by: string;
    request: string;
    acceptance: string;
    task_number: number;
    status: string;
    question: string | null;
    links: string;
    verification: string | null;
    watched_card: string | null;
    created_at: number;
  };
  // A handoff with its task's status and links, while the requester is still a
  // member of the project's workspace: a chief sees no project its owner left.
  const select = `SELECT handoffs.id, handoffs.bot_id, projects.workspace_id, handoffs.project_id, projects.name AS project,
      project_tasks.title, users.login AS requested_by, handoffs.request, handoffs.acceptance, handoffs.task_number,
      project_tasks.status, project_tasks.question, project_tasks.links, project_tasks.verification, handoffs.watched_card, handoffs.created_at
    FROM handoffs
    JOIN projects ON projects.id = handoffs.project_id
    JOIN project_tasks ON project_tasks.project_id = handoffs.project_id AND project_tasks.number = handoffs.task_number
    JOIN users ON users.id = handoffs.user_id
    JOIN workspace_members ON workspace_members.workspace_id = projects.workspace_id AND workspace_members.user_id = handoffs.user_id`;
  // The task's verdict on its latest pull request, as a line.
  const verdictOf = (row: HandoffRow) => {
    const links = TaskLink.array().parse(JSON.parse(row.links));
    const verification = currentVerification({ links, verification: row.verification === null ? null : Verification.parse(JSON.parse(row.verification)) });
    return verification && VerdictLine.parse(verification);
  };
  const toHandoff = (row: HandoffRow): Handoff =>
    Handoff.parse({
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      project: row.project,
      title: row.title,
      requestedBy: row.requested_by,
      request: row.request,
      acceptance: row.acceptance,
      taskNumber: row.task_number,
      status: row.status,
      question: row.question,
      links: JSON.parse(row.links),
      workers: workers.workersOf(ProjectId.parse(row.project_id)).filter(({ taskNumber }) => taskNumber === row.task_number),
      verification: verdictOf(row),
      summary: projects.lastReply(
        db
          .query<{ turn_id: string }, [string]>("SELECT turn_id FROM handoff_messages WHERE handoff_id = ?1")
          .all(row.id)
          .map(({ turn_id }) => TurnId.parse(turn_id)),
      ),
      createdAt: row.created_at,
    });
  // The handoff's card: where it stands, from its task.
  const cardOf = (row: HandoffRow): HandoffCard => {
    const pullRequests = TaskLink.array()
      .parse(JSON.parse(row.links))
      .flatMap((link) => (link.kind === "pull-request" ? [link.url] : []));
    const verification = verdictOf(row);
    return HandoffCard.parse({
      handoffId: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      project: row.project,
      title: row.title,
      taskNumber: row.task_number,
      stage: stageOf(TaskStatus.parse(row.status), pullRequests.length > 0, verification?.result === "pass" && !verification.stale),
      question: row.question,
      pullRequests,
      verification,
    });
  };
  const byId = (handoffId: string) => {
    const row = db.query<HandoffRow, [string]>(`${select} WHERE handoffs.id = ?1`).get(handoffId);
    return row ? toHandoff(row) : null;
  };

  // One message of a handoff to its coordinator: `question` is the one it answers, null for none.
  type Delivery = { deliveryId: string; message: string; question: string | null };

  // Queues `text` for the coordinator in the requester's chat, behind their own
  // unanswered message if there is one, as the handoff's `delivery`.
  const deliver = (handoff: Handoff, userId: UserId, { deliveryId, message, question }: Delivery, text: string) => {
    const queued = projects.queueTurn(handoff.projectId, userId, text, true);
    if (!queued) throw new Error("a handoff's message was not queued");
    db.query(
      "INSERT INTO handoff_messages (handoff_id, delivery_id, message, question, turn_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).run(handoff.id, deliveryId, message, question, queued.turnId, Date.now());
    return queued;
  };
  const refused = (code: "delivery_reused" | "handoff_closed" | "question_changed", message: string) => ({ refused: code, message });

  return {
    // The bot's handoff to the project: a new open task in its ledger, requested
    // by the bot's owner, and its message queued for the coordinator in the
    // owner's chat. The caller checked that the owner is a member, and publishes `queued`.
    create: db.transaction(
      (botId: BotId, owner: { userId: UserId; login: string }, projectId: ProjectId, args: z.output<typeof SendToProjectArgs>) => {
        const detail = `${args.request}\n\nDone when: ${args.acceptance}`;
        const task = projects.createTask(projectId, { title: args.title, detail, owner: null }, owner.login);
        const id = HandoffId.parse(`handoff_${crypto.randomUUID()}`);
        db.query(
          `INSERT INTO handoffs (id, bot_id, user_id, project_id, task_number, request, acceptance, watched_card, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8)`,
        ).run(id, botId, owner.userId, projectId, task.number, args.request, args.acceptance, Date.now());
        const handoff = byId(id);
        if (!handoff) throw new Error("handoff insert returned no row");
        const request = { deliveryId: "request", message: args.request, question: null };
        return { handoff, queued: deliver(handoff, owner.userId, request, requestMessage(handoff, args.title)) };
      },
    ),

    // A follow-up to the bot's handoff, from the bot (`chief`) or from its owner
    // on the handoff's card (`owner`), naming the question it answers (null for
    // none): added to the task's detail (an answer with its question), and
    // queued for the coordinator in the owner's chat. A delivery id seen before
    // with the same message and question changes nothing (`queued` is null).
    // Refused for a delivery id seen with another message or question, a task
    // that is done or abandoned (new work is a new handoff), or a question other
    // than the one the task asks now: whoever answers must answer it. Null when
    // the bot has no such handoff or its owner left the project's workspace.
    followUp: db.transaction((botId: BotId, handoffId: HandoffId, from: "chief" | "owner", delivery: Delivery) => {
      const row = db.query<{ user_id: string }, [string, string]>("SELECT user_id FROM handoffs WHERE id = ?1 AND bot_id = ?2").get(handoffId, botId);
      const handoff = row && byId(handoffId);
      if (!row || !handoff) return null;
      const { requestedBy, project, status, question, taskNumber } = handoff;
      const { deliveryId, message } = delivery;
      const delivered = db
        .query<Omit<Delivery, "deliveryId">, [string, string]>("SELECT message, question FROM handoff_messages WHERE handoff_id = ?1 AND delivery_id = ?2")
        .get(handoffId, deliveryId);
      if (delivered?.message === message && delivered.question === delivery.question) return { handoff, queued: null };
      if (delivered) return refused("delivery_reused", `Delivery ${deliveryId} already carried another message: send this one under a new id`);
      if (status === "done" || status === "abandoned") {
        return refused("handoff_closed", `Task #${taskNumber} in ${project} is ${status}: hand over new work with send_to_project`);
      }
      if (delivery.question !== question) {
        return refused("question_changed", question ? `${project} now asks: ${question}` : `${project} asks no question now`);
      }
      const by = from === "chief" ? `${requestedBy}'s chief of staff` : requestedBy;
      const added = question ? `${by} answered "${question}": ${message}` : `Follow-up from ${by}: ${message}`;
      db.query("UPDATE project_tasks SET detail = detail || ?3, updated_at = ?4 WHERE project_id = ?1 AND number = ?2").run(
        handoff.projectId,
        taskNumber,
        `\n\n${added}`,
        Date.now(),
      );
      const header = from === "chief" ? "from your chief of staff" : "your answer from your chief of staff's chat";
      const text = `About task #${taskNumber}, ${header}:\n\n${message}`;
      return { handoff, queued: deliver(handoff, UserId.parse(row.user_id), delivery, text) };
    }),

    // The watcher, run after every change to the project's ledger, and for every
    // project (no `projectId`) when control starts, for a change whose watch a
    // crash cut short: each handoff whose card differs from the one last posted
    // gets its new card in its chief's chat. A change the card does not show
    // posts nothing, and neither does a handoff from before cards the first
    // time: its notices were posted already. Once the owner has left the
    // project's workspace, their chief hears no more. Returns the cards, to publish.
    watch: db.transaction((projectId?: ProjectId): Array<{ botId: BotId; event: ChatEvent }> => {
      const rows = db.query<HandoffRow, [string | null]>(`${select} WHERE ?1 IS NULL OR handoffs.project_id = ?1`).all(projectId ?? null);
      return rows.flatMap((row) => {
        const card = cardOf(row);
        const shown = JSON.stringify(card);
        // The card last posted, as it shows now: one from before a field was added gets its default, so no change is seen.
        const last = row.watched_card ? JSON.stringify(HandoffCard.parse(JSON.parse(row.watched_card))) : row.watched_card;
        if (shown === last) return [];
        db.query("UPDATE handoffs SET watched_card = ?2 WHERE id = ?1").run(row.id, shown);
        if (row.watched_card === null) return [];
        const botId = BotId.parse(row.bot_id);
        return [{ botId, event: postCard(botId, { type: "handoff-card", card }) }];
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

// The coordinator's message for a handoff, in the requester's chat with it.
function requestMessage({ requestedBy, taskNumber, request, acceptance }: Handoff, title: string) {
  return [
    `${requestedBy}'s chief of staff handed this to the project. It is task #${taskNumber} in the ledger: work on that task, and do not add another for it.`,
    "",
    title,
    request,
    "",
    `Done when: ${acceptance}`,
    "",
    `Set task #${taskNumber} to needs_input with your question when you need ${requestedBy}'s answer, and to done once that holds, with links to what it delivered.`,
  ].join("\n");
}

function stageOf(status: TaskStatus, pullRequest: boolean, passed: boolean): HandoffStage {
  if (status === "done" || status === "abandoned" || status === "needs_input") return status;
  if (passed) return "verified";
  if (pullRequest) return "pr_opened";
  return status === "in_progress" ? "working" : "accepted";
}
