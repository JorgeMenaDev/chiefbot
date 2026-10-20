import {
  ENGINEER_SETUP,
  AnswerApprovalRequest,
  type ApprovalId,
  PullRequestArgs,
  WorkerToControl,
  type AgentConnector,
  type ApprovalKind,
  type ChatEvent,
  type ClientEvent,
  type ControlToWorker,
  type CoordinatorToolCall,
  type CopilotPayer,
  type EngineerSetup,
  type OpenedPullRequest,
  type Project,
  type ProjectId,
  type ProjectMember,
  type Task,
  type TaskWorker,
  type TaskWorkerId,
  type TurnId,
  type UserId,
  type WorkerTranscript,
  type WorkspaceId,
} from "@chiefbot/contracts";
import type { controlApprovals } from "./approvals.ts";
import type { Clock } from "@chiefbot/worker/clock";
import type { ComputerProvider } from "./computers/computer.ts";
import type { copilotIdentity, CopilotToken } from "./copilotIdentity.ts";
import { apiError, bearer, unauthorized } from "./http.ts";
import type { repoAccess, RepoAgent } from "./repos.ts";
import type { openStore } from "./store.ts";
import { heldTurn, taskWorkerTurn, type TaskWorkerTurn } from "./turnKeys.ts";

// A task worker's WebSocket: the worker of exactly one task worker, the turn it
// runs and the member who asked for it.
export type TaskWorkerSocketData = { kind: "task-worker"; workerId: TaskWorkerId; turnId: TurnId; userId: UserId };

// The coordinator's worker tools.
export type WorkerToolCall = Extract<CoordinatorToolCall, { tool: "dispatch_worker" | "worker_status" | "worker_transcript" | "stop_worker" }>;

// The slice of a Bun ServerWebSocket this module uses.
type Socket = { send(message: string): unknown; close(code?: number, reason?: string): void };

export type TaskWorkerHostOptions = {
  store: ReturnType<typeof openStore>;
  // Who pays for a worker's Copilot: as for the coordinator, the member who asked or their organization.
  payerOf: ReturnType<typeof copilotIdentity>;
  // The project's connectors ready for the member who asked (connectors.ts).
  connectorsFor: (projectId: ProjectId, userId: UserId) => Promise<AgentConnector[]>;
  // The values of the project's secrets that are set, by name (projects.ts). Throws when they cannot be read.
  secretsFor: (projectId: ProjectId) => Promise<Record<string, string>>;
  computers: ComputerProvider;
  approvals: ReturnType<typeof controlApprovals>;
  // A worker that waits this long on one approval stops, keeping its disk.
  approvalWaitMinutes: number;
  // Times those waits. A fake in tests.
  clock: Clock;
  // Opens a pull request after the requester approves it (repos.ts).
  pullRequest: ReturnType<typeof repoAccess>["pullRequest"];
  // Control's URL as a computer reaches it.
  controlUrlForComputers: () => string;
  // Sends a ClientEvent to every /events socket of the user.
  publishToUser: (userId: UserId, event: ClientEvent) => void;
  // The project's task ledger changed (a worker linked its pull request).
  onLedgerChange: (projectId: ProjectId) => void;
  // Upgrades the request to the worker's WebSocket; undefined once upgraded.
  upgrade: (req: Request, data: TaskWorkerSocketData) => Response | undefined;
};

// A project's workers, its engineers: one task each, on a throwaway computer
// from the ComputerProvider. The coordinator dispatches them (dispatch_worker):
// control writes the launch record first, keyed by the tool call's creation id,
// then asks for the computer, so a resent call starts no second worker. A
// project runs at most its workers.max at once: another dispatch is queued, and
// launches once one of them has ended and its computer has stopped or gone (a
// place is held until then: taskWorkerStore.ts). The worker is a bot's worker (apps/worker) on
// control's /task-worker routes: it runs the task as one turn for the member who
// asked, on the Copilot that pays for it (their seat, or their organization's:
// copilotIdentity.ts) and with the project's connectors ready for them (through
// connectors.ts's proxy). It first sets up (setting_up): it clones the repo
// through control's git proxy and runs the project's setup command with the
// project's secrets, which control sends with its task and nowhere else
// (EngineerSetup), only while its turn is live on the connection that asked; a
// step that fails blocks it. Its worker hides those secrets in all it sends
// (secretRedactor.ts). Then its agent works on the task:
// it pushes through the git proxy and opens a draft pull request through
// control, each push and pull request approved by that member, or ends with a
// report when nothing needs to change. Its last message is its result; its pull
// request is linked on the task. Its computer stops as soon as its turn ends,
// keeping its disk, and goes once the worker is stopped or its task is done or
// abandoned; on start, control stops every computer of an ended turn, removes
// every one that should be gone and launches what the queue has room for (`recover`).
//
// Member routes (a session; 404 to anyone outside the project's workspace):
//   GET  /projects/:id/workers  → TaskWorker[]. Every change also reaches each member's
//                                /events as a `workers` ClientEvent.
//   POST /projects/:id/workers/:workerId/approvals/:approvalId  body AnswerApprovalRequest → 204
//                                (403 requester_only for anyone but the member who asked;
//                                409 not_pending when it is answered, unknown or its turn ended)
// Worker routes. The WebSocket takes the task worker's credential (403 for another worker's); every
// other route takes the key of the worker's running turn (403 invalid_turn_key otherwise):
//   WS   /task-worker/:workerId                ControlToWorker; WorkerToControl back
//   GET  /task-worker/:workerId/github-token   → BrokeredGitHubToken of the member who asked, when
//                                its task runs on their seat (404 otherwise; 403 reauth_needed)
//   GET  /task-worker/:workerId/installation-token  → CopilotInstallationToken, when its task runs
//                                on the organization's Copilot (404 otherwise; 502 copilot_token_failed)
//   POST /task-worker/:workerId/pull-requests  body PullRequestArgs → 201 OpenedPullRequest, a draft,
//                                once the member who asked approves (errors as a bot's)
// The git proxy (repos.ts) takes the turn's key through agentOf.
export function taskWorkerHost({
  store,
  payerOf,
  connectorsFor,
  secretsFor,
  computers,
  approvals,
  approvalWaitMinutes,
  clock,
  pullRequest,
  controlUrlForComputers,
  publishToUser,
  onLedgerChange,
  upgrade,
}: TaskWorkerHostOptions) {
  const { projects, taskWorkers: workers } = store;
  // Each worker's connected socket, and each launch control is making the computer for.
  const sockets = new Map<TaskWorkerId, Socket>();
  const launches = new Map<TaskWorkerId, Promise<void>>();
  // The wait limit of each approval a worker waits on: its cancel, by approval id.
  const waitLimits = new Map<ApprovalId, () => void>();
  // The next try of each ended worker's computer stop that failed: its cancel.
  const stopRetries = new Map<TaskWorkerId, () => void>();

  const publish = (projectId: ProjectId) => {
    const event = { type: "workers", projectId, workers: workers.workersOf(projectId) } satisfies ClientEvent;
    for (const userId of projects.memberIds(projectId)) publishToUser(userId, event);
  };
  const publishTasks = (projectId: ProjectId) => {
    const event = { type: "tasks", projectId, tasks: projects.tasks(projectId) } satisfies ClientEvent;
    for (const userId of projects.memberIds(projectId)) publishToUser(userId, event);
    onLedgerChange(projectId);
  };
  const send = (workerId: TaskWorkerId, message: ControlToWorker) => sockets.get(workerId)?.send(JSON.stringify(message));
  const refused = (message: string, status = 400) => apiError(status, "invalid_tool_call", message);

  // What a worker's turn acts as for repo access: the member who asked, asked
  // in that turn. An approval whose request goes away first (the worker's
  // runtime stopped, as when its turn is cut to renew its token) is withdrawn.
  const agentOf = ({ workerId, projectId, userId, turnId }: TaskWorkerTurn): RepoAgent => ({
    userId,
    async ask(kind, detail, signal) {
      let asked: ApprovalId | null = null;
      const outcome = await approvals.ask((approvalId) => {
        const now = clock.now();
        const event = workers.requestApproval(workerId, turnId, { approvalId, kind, detail }, now);
        if (event) {
          asked = approvalId;
          limitWait(workerId, approvalId, now);
          publish(projectId);
        }
        return event;
      }, signal);
      if (asked && signal.aborted && workers.withdrawApproval(workerId, asked)) {
        stopWaitLimit(asked);
        publish(projectId);
      }
      return outcome;
    },
  });

  // A worker still waiting on the approval approvalWaitMinutes after `requestedAt`
  // fails, and its computer stops, keeping its disk (turnOver): it costs nothing
  // while it waits. Its requester's answer comes too late; the coordinator can
  // dispatch the task again.
  function limitWait(workerId: TaskWorkerId, approvalId: ApprovalId, requestedAt: number) {
    const due = requestedAt + approvalWaitMinutes * 60_000 - clock.now();
    waitLimits.set(
      approvalId,
      clock.setTimeout(() => {
        waitLimits.delete(approvalId);
        const worker = workers.worker(workerId);
        if (!worker?.pendingApprovals.some((pending) => pending.approvalId === approvalId)) return;
        const message = `It waited over ${approvalWaitMinutes} minutes for ${worker.requestedBy} to approve, so its computer stopped, keeping its disk. Dispatch the task again to retry.`;
        const [ended] = workers.end(workerId, "failed", message);
        if (!ended) return;
        turnOver(workerId, ended.turnId);
        publish(worker.projectId);
      }, Math.max(0, due)),
    );
  }

  // The approval no longer waits: its wait limit is cancelled.
  const stopWaitLimit = (approvalId: ApprovalId) => {
    waitLimits.get(approvalId)?.();
    waitLimits.delete(approvalId);
  };

  // A new worker credential.
  const newToken = () => crypto.randomUUID() + crypto.randomUUID();

  // Makes the worker's computer, a launch that a resent dispatch and a reap wait
  // for. A failure fails the worker and removes what was made, which frees its place.
  function launch(projectId: ProjectId, workerId: TaskWorkerId, token: string) {
    const launched = (async () => {
      try {
        await computers.create({
          id: workerId,
          env: { CHIEFBOT_CONTROL_URL: controlUrlForComputers(), CHIEFBOT_TASK_WORKER_ID: workerId, CHIEFBOT_TASK_WORKER_TOKEN: token },
        });
        await computers.start(workerId);
      } catch (error) {
        workers.launchFailed(workerId, `Its computer could not start: ${error instanceof Error ? error.message : String(error)}`);
        void reap();
      }
      publish(projectId);
    })();
    launches.set(workerId, launched);
    void launched.finally(() => launches.delete(workerId));
    return launched;
  }

  // Launches the project's queued workers, oldest first, while it runs fewer than its workers.max.
  function promote(projectId: ProjectId) {
    const max = projects.project(projectId)?.config.workers.max;
    if (max === undefined) return;
    for (let token = newToken(), next = workers.dequeue(projectId, max, token); next; token = newToken(), next = workers.dequeue(projectId, max, token)) {
      publish(projectId);
      void launch(projectId, next, token);
    }
  }

  // Deletes every worker computer that must go (after any launch still making
  // it). One that fails stays marked, for the next reap.
  async function reap() {
    for (const workerId of workers.toReap()) {
      await launches.get(workerId);
      sockets.get(workerId)?.close();
      const projectId = workers.worker(workerId)?.projectId;
      try {
        await computers.destroy(workerId, { deleteData: true });
        workers.computerRemoved(workerId);
        if (projectId) promote(projectId);
      } catch (error) {
        console.error(`could not remove the computer of ${workerId}:`, error);
      }
      if (projectId) publish(projectId);
    }
  }

  // The worker's turn ended: its approvals stop waiting and its computer stops
  // (release).
  function turnOver(workerId: TaskWorkerId, turnId: TurnId) {
    approvals.turnEnded(turnId);
    void release(workerId);
  }

  // Stops the ended worker's computer, keeping its disk until the task closes.
  // Only once it has stopped does its place go to a queued worker. A stop that
  // fails is tried again after stopRetryMs, the place held meanwhile, unless the
  // computer no longer needs stopping (it went with its task).
  async function release(workerId: TaskWorkerId) {
    if (!workers.stopPending(workerId)) return;
    try {
      await computers.stop(workerId);
    } catch (error) {
      console.error(`could not stop the computer of ${workerId}:`, error);
      stopRetries.set(
        workerId,
        clock.setTimeout(() => {
          stopRetries.delete(workerId);
          void release(workerId);
        }, stopRetryMs),
      );
      return;
    }
    workers.computerStopped(workerId);
    const projectId = workers.worker(workerId)?.projectId;
    if (projectId) promote(projectId);
  }

  // Ends the worker's turn (if it runs) and marks its computer to go.
  function stop(workerId: TaskWorkerId, message: string) {
    const ended = workers.stop(workerId, message);
    const turnId = ended[0]?.turnId;
    if (turnId) approvals.turnEnded(turnId);
  }

  // The engineer's brief, its first message: the task, the project and how to
  // hand back the work. Its instructions say where its setup cloned the repo.
  function taskPrompt({ name, repo, config }: Project, task: Task, instructions: string) {
    const commands = Object.entries(config.commands).map(([command, line]) => `- ${command}: ${line}`);
    return [
      `You are an engineer of the project ${name} (GitHub repo ${repo}). You have this computer to yourself for one task. Chiefbot cloned the repo and set it up for you.`,
      "",
      `Task #${task.number}: ${task.title}`,
      ...(task.detail ? [task.detail] : []),
      ...(instructions ? ["", "From the project agent:", instructions] : []),
      "",
      ...(commands.length > 0 ? ["The repo's commands:", ...commands, ""] : []),
      "First reproduce the problem, or see how the code behaves now, on the base branch as cloned, before you change anything.",
      "If nothing needs to change (it is already fixed, or the task only asks a question), push nothing: end with a report of what you checked and what you found.",
      "Otherwise work on a new branch, push it and open a draft pull request with create_pull_request. The member who asked for this approves each push and the pull request.",
      "End with a short summary: the pull request's link and what it changes, or your report.",
    ].join("\n");
  }

  // What the engineer sets up: the project's config as it is now, and the values
  // of its secrets. Null when the project is gone.
  async function setupOf(projectId: ProjectId): Promise<EngineerSetup | null> {
    const project = projects.project(projectId);
    if (!project) return null;
    const { repo, config } = project;
    return { repo, command: config.commands.setup ?? null, instructions: config.instructions, skills: config.skills, mcp: config.mcp, secrets: await secretsFor(projectId) };
  }

  const routes = {
    "/projects/:id/workers": {
      GET: (req: Bun.BunRequest<"/projects/:id/workers">) => {
        const user = store.userForSession(bearer(req));
        if (!user) return unauthorized();
        const found = projects.projectFor(user.id, req.params.id);
        if (!found) return apiError(404, "not_found");
        return Response.json(workers.workersOf(found.project.id) satisfies TaskWorker[]);
      },
    },
    // The answer is stored first, so it reaches the worker even if it is offline now.
    "/projects/:id/workers/:workerId/approvals/:approvalId": {
      POST: async (req: Bun.BunRequest<"/projects/:id/workers/:workerId/approvals/:approvalId">) => {
        const user = store.userForSession(bearer(req));
        if (!user) return unauthorized();
        const found = projects.projectFor(user.id, req.params.id);
        const worker = found && workers.workerIn(found.project.id, req.params.workerId);
        if (!worker) return apiError(404, "not_found");
        if (worker.requestedBy !== user.login) return apiError(403, "requester_only");
        const body = AnswerApprovalRequest.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_answer");
        const answer = workers.answerApproval(worker.id, req.params.approvalId, body.data.approved);
        if (!answer || answer.event.type !== "approval-answer") return apiError(409, "not_pending");
        const { approvalId, approved } = answer.event;
        stopWaitLimit(approvalId);
        approvals.answered(approvalId, approved);
        send(worker.id, { type: "approval-answer", approvalId, approved });
        publish(worker.projectId);
        return new Response(null, { status: 204 });
      },
    },
    "/task-worker/:workerId": {
      GET: (req: Bun.BunRequest<"/task-worker/:workerId">) => {
        const own = ownWorker(req);
        return own instanceof Response ? own : upgrade(req, { kind: "task-worker", workerId: own.workerId, turnId: own.turnId, userId: own.userId });
      },
    },
    // The token broker: the access token of the member who asked, never a refresh token.
    "/task-worker/:workerId/github-token": {
      GET: (req: Bun.BunRequest<"/task-worker/:workerId/github-token">) => turnToken(req, "seat"),
    },
    "/task-worker/:workerId/installation-token": {
      GET: (req: Bun.BunRequest<"/task-worker/:workerId/installation-token">) => turnToken(req, "org"),
    },
    // The worker's create_pull_request tool. Waits, however long, for the requester's
    // answer; once opened, as a draft, the pull request is linked on the worker and its task.
    "/task-worker/:workerId/pull-requests": {
      POST: async (req: Bun.BunRequest<"/task-worker/:workerId/pull-requests">, server: Bun.Server<unknown>) => {
        const turn = heldTurn(store.turnKeys, req, taskWorkerTurn(req.params.workerId));
        if (turn instanceof Response) return turn;
        const args = PullRequestArgs.safeParse(await req.json().catch(() => null));
        if (!args.success) return apiError(400, "invalid_pull_request");
        server.timeout(req, 0);
        const opened = await pullRequest(agentOf(turn), args.data, req.signal, { draft: true });
        if ("error" in opened) return apiError(opened.status, opened.error, opened.message);
        const worker = workers.worker(turn.workerId);
        if (worker) {
          workers.setPullRequest(worker.id, opened.url);
          const task = projects.tasks(worker.projectId).find(({ number }) => number === worker.taskNumber);
          if (task && !task.links.some((link) => link.kind === "pull-request" && link.url === opened.url)) {
            projects.updateTask(worker.projectId, { number: task.number, links: [{ kind: "pull-request", url: opened.url }] });
            publishTasks(worker.projectId);
          }
          publish(worker.projectId);
        }
        return Response.json(opened satisfies OpenedPullRequest, { status: 201 });
      },
    },
  };

  // The token for the turn the request's key holds, if who pays for it is of `kind`; 404 otherwise.
  async function turnToken(req: Request & { params: { workerId: string } }, kind: CopilotPayer["kind"]) {
    const turn = heldTurn(store.turnKeys, req, taskWorkerTurn(req.params.workerId));
    if (turn instanceof Response) return turn;
    const run = payerOf({ kind: "project", projectId: turn.projectId, askerId: turn.userId });
    if (!run || run.payer.kind !== kind) return apiError(404, "not_found");
    const token: CopilotToken = await run.token();
    if ("error" in token) return token.error === "reauth_needed" ? apiError(403, token.error) : apiError(502, token.error, token.message);
    return Response.json(token.token);
  }

  // Starts the worker's task, once: on the Copilot of whoever pays for the
  // member who asked, with the connectors ready for them and its setup. On the
  // organization's Copilot the worker renews its one-hour token mid-task
  // (installationSession.ts). Secrets control cannot read block it: its setup cannot run.
  async function startTask(workerId: TaskWorkerId, projectId: ProjectId, userId: UserId) {
    // The connection whose hello started it: the task goes there or nowhere.
    const socket = sockets.get(workerId);
    const run = payerOf({ kind: "project", projectId, askerId: userId });
    const started = run && workers.startTurn(workerId, run.payer);
    if (!run || !started) return;
    const turnKey = store.turnKeys.issue({ agent: "task-worker", workerId, projectId, userId, turnId: started.turnId });
    publish(projectId);
    const connectors = await connectorsFor(projectId, userId).catch(() => []);
    const setup = await setupOf(projectId).catch((error: unknown) => {
      console.error(`could not read the secrets of ${projectId} for ${workerId}: ${error instanceof Error ? error.name : "unknown error"}`);
      return null;
    });
    if (!setup) {
      if (workers.end(workerId, "blocked", "Chiefbot could not read the project's secrets, so its setup did not run. Dispatch the task again.").length > 0) {
        turnOver(workerId, started.turnId);
      }
      publish(projectId);
      return;
    }
    // The turn may have ended, its member left or its worker reconnected while
    // control read the secrets: then they, and the task, go nowhere.
    const live = socket && sockets.get(workerId) === socket && store.turnKeys.holder(turnKey) && store.projects.member(projectId, { userId });
    if (!live) return;
    socket.send(JSON.stringify({ type: "run-task", turnId: started.turnId, turnKey, text: started.prompt, payer: run.payer, connectors, setup } satisfies ControlToWorker));
  }

  // The worker whose credential the request carries, if it is :workerId's; 401 or 403 otherwise.
  // Only the WebSocket takes it: every other worker route takes its turn's key.
  function ownWorker(req: Request & { params: { workerId: string } }) {
    const own = workers.forToken(bearer(req));
    if (!own) return unauthorized();
    if (own.workerId !== req.params.workerId) return apiError(403, "wrong_bot");
    return own;
  }

  return {
    routes,

    // Asks the member who asked for the worker to approve `detail` in its turn
    // (a connector call), as its pushes are asked.
    ask: (turn: TaskWorkerTurn, kind: ApprovalKind, detail: string, signal: AbortSignal) => agentOf(turn).ask(kind, detail, signal),

    // For the git proxy: the worker's turn as a repo agent.
    agentOf,

    // One of the coordinator's worker tools, in the turn of `asker`. Answers the
    // call's result as JSON, or a refusal the model sees.
    async tool(project: Project, asker: ProjectMember, call: WorkerToolCall): Promise<Response> {
      if (call.tool === "dispatch_worker") {
        const task = projects.tasks(project.id).find(({ number }) => number === call.task);
        if (!task) return refused(`No task #${call.task} in this project`, 404);
        if (task.status === "done" || task.status === "abandoned") return refused(`Task #${task.number} is ${task.status}`);
        const token = newToken();
        const record = workers.launch({
          projectId: project.id,
          taskNumber: task.number,
          creationId: call.creationId,
          userId: asker.userId,
          prompt: taskPrompt(project, task, call.instructions),
          token,
          max: project.config.workers.max,
        });
        if ("busy" in record) return refused(`Worker ${record.busy.id} still works on task #${task.number}: stop it first, or wait for it`, 409);
        const { id } = record.worker;
        if (record.launched) publish(project.id);
        // A new worker launches now, unless it is queued. A resent call waits for the first one's launch.
        if (record.launched && record.worker.state === "launching") await launch(project.id, id, token);
        else await launches.get(id);
        return Response.json(workers.worker(id) satisfies TaskWorker | null);
      }
      if (call.tool === "worker_status" && call.worker === undefined) return Response.json(workers.workersOf(project.id) satisfies TaskWorker[]);
      const worker = call.worker === undefined ? null : workers.workerIn(project.id, call.worker);
      if (!worker) return refused(`No worker ${call.worker} in this project`, 404);
      switch (call.tool) {
        case "worker_status":
          return Response.json(worker satisfies TaskWorker);
        case "worker_transcript": {
          const lines = transcriptLines(workers.transcript(worker.id));
          return Response.json({ worker: worker.id, lines: lines.slice(-call.lines), truncated: lines.length > call.lines } satisfies WorkerTranscript);
        }
        case "stop_worker":
          stop(worker.id, "The coordinator stopped this worker.");
          publish(project.id);
          void reap();
          return Response.json(workers.worker(worker.id) satisfies TaskWorker | null);
      }
    },

    // The member left the workspace or was removed: the workers they asked for
    // stop and their computers go.
    memberRemoved(workspaceId: WorkspaceId, userId: UserId) {
      const stopped = workers.runningFor(workspaceId, userId);
      for (const { workerId } of stopped) stop(workerId, "The member who asked for it left the workspace.");
      for (const projectId of new Set(stopped.map(({ projectId }) => projectId))) publish(projectId);
      void reap();
    },

    // The task is done or abandoned: its workers stop and their computers go.
    taskClosed(projectId: ProjectId, taskNumber: number) {
      for (const workerId of workers.running(projectId, taskNumber)) stop(workerId, "The task was closed.");
      publish(projectId);
      void reap();
    },

    // The project is being deleted: its workers stop and every computer of theirs
    // goes now. Throws when one cannot be removed, so nothing is deleted.
    async removeProject(projectId: ProjectId) {
      for (const workerId of workers.running(projectId)) stop(workerId, "The project was deleted.");
      for (const workerId of workers.toReap(projectId)) {
        await launches.get(workerId);
        sockets.get(workerId)?.close();
        await computers.destroy(workerId, { deleteData: true });
        workers.computerRemoved(workerId);
      }
    },

    // On control's start: every approval a worker waits on gets its wait limit
    // again. A worker still launching whose computer is not running lost its
    // launch to the restart, so it fails. A computer whose turn ended but still
    // runs stops. Then every worker computer that should be gone is removed, and
    // queued workers launch where there is room.
    async recover() {
      for (const { workerId, approvalId, requestedAt } of workers.waitingApprovals()) limitWait(workerId, approvalId, requestedAt);
      for (const workerId of workers.launching()) {
        if ((await computers.status(workerId)) !== "running") workers.launchFailed(workerId, "Control restarted before its computer was ready.");
      }
      for (const workerId of workers.ended()) {
        if ((await computers.status(workerId)) === "running") await release(workerId);
        else workers.computerStopped(workerId);
      }
      await reap();
      for (const projectId of workers.queuedProjects()) promote(projectId);
    },

    // Control is stopping: no wait limit or stop retry fires any more.
    stop() {
      for (const cancel of [...waitLimits.values(), ...stopRetries.values()]) cancel();
      waitLimits.clear();
      stopRetries.clear();
    },

    open(ws: Socket, { workerId }: TaskWorkerSocketData) {
      // One connection per worker: a reconnecting worker replaces its stale socket.
      sockets.get(workerId)?.close(4000, "replaced");
      sockets.set(workerId, ws);
      ws.send(JSON.stringify({ type: "bound" } satisfies ControlToWorker));
    },

    close(ws: Socket, { workerId }: TaskWorkerSocketData) {
      if (sockets.get(workerId) === ws) sockets.delete(workerId);
    },

    message({ workerId, turnId, userId }: TaskWorkerSocketData, raw: string | Buffer) {
      const message = WorkerToControl.parse(JSON.parse(String(raw)));
      const worker = workers.worker(workerId);
      if (!worker) return;
      if (message.type === "turn-event") {
        const now = clock.now();
        const stored = workers.appendTurnEvent(workerId, message.turnId, message.index, message.event, now);
        if (!stored) return;
        if (message.event.type === "approval-request") limitWait(workerId, message.event.approvalId, now);
        if (message.event.type === "approval-withdrawn") stopWaitLimit(message.event.approvalId);
        if (message.event.type === "done") turnOver(workerId, message.turnId);
        if (["done", "approval-request", "approval-withdrawn", "setup-step", "setup-done"].includes(message.event.type)) publish(worker.projectId);
        return;
      }
      // The models report is for a bot's model picker, and connection calls for a
      // bot's turn: a task worker sends neither.
      if (message.type === "models" || message.type === "connection-calls") return;
      // Hello. The first one starts the task, if the worker can set up; after
      // that, the worker lost the task unless it says it still runs it, and may
      // have missed answers.
      const started = worker.state === "setting_up" || worker.state === "working";
      if (worker.state === "launching" && !message.capabilities.includes(ENGINEER_SETUP)) {
        if (workers.end(workerId, "blocked", outdatedImage).length > 0) turnOver(workerId, turnId);
        publish(worker.projectId);
      } else if (worker.state === "launching") {
        void startTask(workerId, worker.projectId, userId);
      } else if (started && message.activeTurnId !== turnId) {
        workers.end(workerId, "failed", "The worker's computer restarted before it finished the task.");
        turnOver(workerId, turnId);
        publish(worker.projectId);
      } else if (started) {
        for (const answer of workers.answeredApprovals(workerId, turnId)) send(workerId, { type: "approval-answer", ...answer });
        // Control restarted since the turn started: it gets a new key.
        if (store.turnKeys.missing(turnId)) {
          send(workerId, { type: "turn-key", turnId, turnKey: store.turnKeys.issue({ agent: "task-worker", workerId, projectId: worker.projectId, userId, turnId }) });
        }
      }
    },
  };
}

// Why an engineer whose worker cannot set up (no ENGINEER_SETUP in its hello) is blocked.
const outdatedImage =
  "Its computer runs an older Chiefbot image, which cannot set up an engineer. Rebuild the computer image (`bun run computer:build`), then dispatch the task again.";

// How long control waits to try again to stop an ended worker's computer.
const stopRetryMs = 30_000;

// A worker's turn as transcript lines for the coordinator: each setup step with
// its exit code (and its log when it failed), each message whole, each tool call
// with its latest status, approvals, answers and errors.
function transcriptLines(events: ChatEvent[]): string[] {
  const lines: string[] = [];
  // Where each message and tool call is, to grow or update its line.
  const at = new Map<string, number>();
  const put = (key: string, line: (previous: string | undefined) => string) => {
    const index = at.get(key);
    if (index === undefined) at.set(key, lines.push(line(undefined)) - 1);
    else lines[index] = line(lines[index]);
  };
  for (const { event } of events) {
    switch (event.type) {
      case "text-delta":
        put(`message:${event.messageId}`, (previous) => (previous ?? "worker: ") + event.text);
        break;
      case "tool-call":
        put(`tool:${event.toolCallId}`, () => `tool ${event.name}: ${event.status}`);
        break;
      case "approval-request":
        lines.push(`asked to approve (${event.kind}): ${event.detail}`);
        break;
      case "approval-answer":
        lines.push(event.approved ? "approved" : "declined");
        break;
      case "approval-withdrawn":
        lines.push("approval withdrawn");
        break;
      case "error":
        lines.push(`error: ${event.message}`);
        break;
      case "setup-step": {
        const { step, command, exitCode, log } = event.step;
        lines.push(`${step}: ${command} (exit ${exitCode})${exitCode === 0 ? "" : `\n${log}`}`);
        break;
      }
      case "setup-done":
        lines.push(
          ["setup done", ...(event.instructions.length > 0 ? [`instructions ${event.instructions.join(", ")}`] : []), ...(event.skills.length > 0 ? [`skills ${event.skills.join(", ")}`] : [])].join("; "),
        );
        break;
    }
  }
  return lines;
}
