import {
  ENGINEER_SETUP,
  VERIFIER,
  AnswerApprovalRequest,
  type ApprovalId,
  ContextImagePath,
  ContextPath,
  isPng,
  latestPullRequest,
  PullRequestArgs,
  SCREENSHOT_BYTES_MAX,
  VerdictReport,
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
  type RecordedVerdict,
  type ProjectId,
  type ProjectMember,
  type ScreenControl,
  type Task,
  type TaskLink,
  type Template,
  type TaskWorker,
  type TaskWorkerId,
  type TurnId,
  type UserId,
  type Verification,
  type WorkerTranscript,
  type WorkspaceId,
} from "@chiefbot/contracts";
import type { controlApprovals } from "./approvals.ts";
import type { Clock } from "@chiefbot/worker/clock";
import type { ComputerProvider } from "./computers/computer.ts";
import type { ContextStore } from "./contextStore.ts";
import type { copilotIdentity, CopilotToken } from "./copilotIdentity.ts";
import { apiError, bearer, unauthorized } from "./http.ts";
import type { PullRequestHead } from "./github.ts";
import type { repoAccess, RepoAgent, RepoReader } from "./repos.ts";
import { viewerBytes } from "./rfbViewer.ts";
import { secretRedactor } from "@chiefbot/worker/secret-redactor";
import { screenTunnel } from "./screens.ts";
import { secretFailure } from "./secrets/secretStore.ts";
import { templateProblem } from "./templates/projectTemplate.ts";
import type { StackPlan, StackRunner } from "./templates/stacks.ts";
import type { VerifiedHead } from "./projectStore.ts";
import type { openStore } from "./store.ts";
import { heldTurn, taskWorkerTurn, type TaskWorkerTurn } from "./turnKeys.ts";
import { queue } from "./queue.ts";
import { z } from "zod";

// A task worker's WebSocket: the worker of exactly one task worker, the turn it
// runs and the member who asked for it.
export type TaskWorkerSocketData = { kind: "task-worker"; workerId: TaskWorkerId; turnId: TurnId; userId: UserId };

// A WebSocket watching a worker: one end of a stream of its screen, a member's
// viewer or the worker piping its VNC server (screens.ts). Or a member
// following its transcript from event `after` on. A member's sockets close when
// they leave the workspace or the project is deleted.
export type WorkerWatchSocketData =
  | { kind: "worker-viewer"; workerId: TaskWorkerId; streamId: string; userId: UserId }
  | { kind: "worker-screen"; streamId: string }
  | { kind: "worker-transcript"; workerId: TaskWorkerId; after: number; userId: UserId };

// The coordinator's worker tools.
export type WorkerToolCall = Extract<CoordinatorToolCall, { tool: "dispatch_worker" | "dispatch_verifier" | "worker_status" | "worker_transcript" | "stop_worker" }>;

// The slice of a Bun ServerWebSocket this module uses.
type Socket = { send(message: string | Buffer): unknown; close(code?: number, reason?: string): void };

// A member watching one of a project's workers: its screen or its transcript.
type Watcher = { workerId: TaskWorkerId; projectId: ProjectId; userId: UserId };

export type TaskWorkerHostOptions = {
  store: ReturnType<typeof openStore>;
  // Who pays for a worker's Copilot: as for the coordinator, the member who asked or their organization.
  payerOf: ReturnType<typeof copilotIdentity>;
  // The project's connectors ready for the member who asked (connectors.ts).
  connectorsFor: (projectId: ProjectId, userId: UserId) => Promise<AgentConnector[]>;
  // The values of the project's secrets that are set, by name (projects.ts). Throws when they cannot be read.
  secretsFor: (projectId: ProjectId) => Promise<Record<string, string>>;
  computers: ComputerProvider;
  // The template catalog, and where each worker's copy of its project's template
  // stack runs (templates/stacks.ts): null where computers have none, as on GCE.
  templates: Template[];
  stacks: StackRunner | null;
  // Whether a member may read a repo, and a token that reads it (repos.ts).
  repoReadable: ReturnType<typeof repoAccess>["readable"];
  repoReadToken: ReturnType<typeof repoAccess>["readToken"];
  approvals: ReturnType<typeof controlApprovals>;
  // A worker that waits this long on one approval stops, keeping its disk.
  approvalWaitMinutes: number;
  // Times those waits. A fake in tests.
  clock: Clock;
  // Where a verifier's report and screenshots go: the project's shared context.
  context: ContextStore;
  // Opens a pull request after the requester approves it, and reads one's head (repos.ts).
  pullRequest: ReturnType<typeof repoAccess>["pullRequest"];
  pullRequestHead: ReturnType<typeof repoAccess>["pullRequestHead"];
  // Control's URL as a computer reaches it.
  controlUrlForComputers: () => string;
  // Sends a ClientEvent to every /events socket of the user.
  publishToUser: (userId: UserId, event: ClientEvent) => void;
  // The project's task ledger changed (a worker linked its pull request).
  onLedgerChange: (projectId: ProjectId) => void;
  // One of the project's workers changed, so its state may have (contracts projectState).
  onStateChange: (projectId: ProjectId) => void;
  // Control queued a turn for the project's coordinator in the member's chat
  // (a task's continuation): their chat shows it, and the scheduler picks it up.
  onTurnQueued: (projectId: ProjectId, userId: UserId, event: ChatEvent) => void;
  // Upgrades the request to a worker's WebSocket, or one watching it; undefined once upgraded.
  upgrade: (req: Request, data: TaskWorkerSocketData | WorkerWatchSocketData) => Response | undefined;
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
// connectors.ts's proxy). It first sets up (setting_up): when the project has a
// template, control starts the worker's own copy of its stack in the computer's
// network namespace (startStack), each stage in its transcript, and a stage
// that fails blocks it. Then the worker clones the repo
// through control's git proxy and runs the project's setup command with the
// project's secrets, which control sends with its task and nowhere else
// (EngineerSetup), only while its turn is live on the connection that asked; a
// step that fails blocks it. Its worker hides those secrets in all it sends
// (secretRedactor.ts). Then its agent works on the task:
// it pushes through the git proxy and opens a draft pull request through
// control, each push and pull request approved by that member, or ends with a
// report when nothing needs to change. Its last message is its result; its pull
// request is linked on the task. Its computer stops as soon as its turn ends,
// keeping its disk (its stack goes then), and goes once the worker is stopped or its task is done or
// abandoned; on start, control stops every computer of an ended turn, removes
// every one that should be gone and launches what the queue has room for (`recover`).
// A verifier (dispatch_verifier) is a worker of the same kind on a computer of
// its own: it checks a task's pull request at the head control read on GitHub
// when it was dispatched, which its setup checks out. Control refuses its
// pushes and pull requests. It ends with a verdict (report_verdict), which
// control keeps with its report and screenshots in the project's context and
// sets on the task (recordVerdict): BLOCKED for a PASS with no screenshot on a
// project with a devUrl, tests only for one no screenshot backs (evidenced),
// and BLOCKED when it ends without one (noVerdict). A worker that ends by
// itself (not stopped) wakes the project's coordinator: one turn, in the chat
// of the member who requested its task, says how it ended, so the task goes on
// with nobody's nudge (workerEnded; at most CONTINUATIONS_MAX per task,
// taskWorkerStore.ts). A push through the git proxy since its commit was
// pinned, or GitHub's head when the coordinator marks the task done
// (doneCheck), makes a verdict stale.
// Control counts the pushes through the proxy to each branch, those started
// and those in flight (projectStore.ts branch_pushes), so a check that reads
// GitHub can tell whether a push came in between.
//
// Member routes (a session; 404 to anyone outside the project's workspace):
//   GET  /projects/:id/workers  → TaskWorker[]. Every change also reaches each member's
//                                /events as a `workers` ClientEvent.
//   POST /projects/:id/workers/:workerId/approvals/:approvalId  body AnswerApprovalRequest → 204
//                                (403 requester_only for anyone but the member who asked;
//                                409 not_pending when it is answered, unknown or its turn ended)
//   WS   /projects/:id/workers/:workerId/screen  ↔ the worker's screen's RFB bytes (noVNC speaks it),
//                                as a bot's screen; 409 worker_offline while its worker is not connected.
//                                Control passes on a viewer's input only while that member drives
//                                (rfbViewer.ts); everyone else watches.
//   POST /projects/:id/workers/:workerId/take-over  → TaskWorker: the member drives its screen; the
//                                worker's tool calls wait meanwhile. One member at a time, from a screen
//                                they have open (409 screen_not_open; 409 screen_taken while another drives)
//   POST /projects/:id/workers/:workerId/hand-back  → TaskWorker: the agent drives its screen again
//                                (409 screen_taken for anyone but the member who drives). Closing their
//                                last view of it, or leaving the workspace, hands it back too.
//   WS   /projects/:id/workers/:workerId/transcript  ?after=<seq> → each ChatEvent of the worker's turn
//                                after seq, then live ones, as a chat's socket sends them
// Worker routes. The WebSocket takes the task worker's credential (403 for another worker's); every
// other route takes the key of the worker's running turn (403 invalid_turn_key otherwise):
//   WS   /task-worker/:workerId                ControlToWorker; WorkerToControl back
//   GET  /task-worker/:workerId/github-token   → BrokeredGitHubToken of the member who asked, when
//                                its task runs on their seat (404 otherwise; 403 reauth_needed)
//   GET  /task-worker/:workerId/installation-token  → CopilotInstallationToken, when its task runs
//                                on the organization's Copilot (404 otherwise; 502 copilot_token_failed)
//   POST /task-worker/:workerId/pull-requests  body PullRequestArgs → 201 OpenedPullRequest, a draft,
//                                once the member who asked approves (errors as a bot's; 403
//                                verifier_read_only for a verifier)
//   POST /task-worker/:workerId/verdict  body VerdictReport → RecordedVerdict: a verifier's verdict, kept
//                                with its report and screenshots in the project's context (403
//                                not_a_verifier; 400 invalid_verdict; 409 verdict_recorded: one per verifier)
//   WS   /task-worker/:workerId/screen/:streamId  the worker's credential ↔ the VNC bytes for one
//                                viewer, after screen-open (404 for a stream control did not open for it)
// The git proxy (repos.ts) takes the turn's key through agentOf.
export function taskWorkerHost({
  store,
  payerOf,
  connectorsFor,
  secretsFor,
  computers,
  templates,
  stacks,
  repoReadable,
  repoReadToken,
  approvals,
  approvalWaitMinutes,
  clock,
  context,
  pullRequest,
  pullRequestHead,
  controlUrlForComputers,
  publishToUser,
  onLedgerChange,
  onStateChange,
  onTurnQueued,
  upgrade,
}: TaskWorkerHostOptions) {
  const { projects, taskWorkers: workers } = store;
  // Each worker's connected socket, and each launch control is making the computer for.
  const sockets = new Map<TaskWorkerId, Socket>();
  const launches = new Map<TaskWorkerId, Promise<void>>();
  // The wait limit of each approval a worker waits on: its cancel, by approval id.
  const waitLimits = new Map<ApprovalId, () => void>();
  // Each worker computer's chore under way (settle), each that must look again
  // when its step is over, and the next try of each whose step failed: its cancel.
  const chores = new Map<TaskWorkerId, Promise<void>>();
  const again = new Set<TaskWorkerId>();
  const retries = new Map<TaskWorkerId, () => void>();
  // Control is stopping: nothing new starts, and no answer that comes after is acted on.
  let stopped = false;
  // The streams of members watching each worker's screen (screens.ts), and
  // each viewer's member and what of its bytes go on (rfbViewer.ts).
  const screens = screenTunnel<TaskWorkerId>({ onStreamEnd: () => {} });
  const viewers = new Map<string, Watcher & { pass: ReturnType<typeof viewerBytes> }>();
  // The one member driving each worker's screen; none while its agent does.
  const holders = new Map<TaskWorkerId, { userId: UserId; login: string }>();
  // The sockets following a worker's transcript, with the last event each was sent.
  const followers = new Map<Socket, Watcher & { after: number }>();

  const controlOf = (workerId: TaskWorkerId): ScreenControl => (holders.has(workerId) ? "human" : "agent");
  const watching = (workerId: TaskWorkerId, userId: UserId) =>
    [...viewers.values()].some((view) => view.workerId === workerId && view.userId === userId);

  // Sends each follower `match` picks the events it has not had yet.
  const sendTranscripts = (match: (follower: Watcher) => boolean) => {
    for (const [socket, follower] of followers) {
      if (!match(follower)) continue;
      const events = workers.transcript(follower.workerId, follower.after);
      for (const event of events) socket.send(JSON.stringify(event satisfies ChatEvent));
      follower.after = events.at(-1)?.seq ?? follower.after;
    }
  };

  // The project's workers as members see them: with who drives each one's screen.
  const workersShown = (projectId: ProjectId): TaskWorker[] =>
    workers.workersOf(projectId).map((worker) => ({ ...worker, screenHolder: holders.get(worker.id)?.login ?? null }));
  // Every worker change reaches the project's members; one control made (an
  // approval asked or answered, a turn ended) reaches each transcript's followers.
  const publish = (projectId: ProjectId) => {
    const event = { type: "workers", projectId, workers: workersShown(projectId) } satisfies ClientEvent;
    for (const userId of projects.memberIds(projectId)) publishToUser(userId, event);
    onStateChange(projectId);
    sendTranscripts((follower) => follower.projectId === projectId);
  };

  // Tells the worker who drives its screen now, and the project's members.
  const screenChanged = (workerId: TaskWorkerId, projectId: ProjectId) => {
    send(workerId, { type: "screen-control", control: controlOf(workerId) });
    publish(projectId);
  };
  // The member no longer drives the worker's screen (they stopped watching, or
  // left): it goes back to the agent.
  const release = (workerId: TaskWorkerId, projectId: ProjectId, userId: UserId) => {
    if (holders.get(workerId)?.userId !== userId) return;
    holders.delete(workerId);
    screenChanged(workerId, projectId);
  };
  // Closes the screens and transcripts that `match` picks, handing back any
  // control their members held.
  const closeWatchers = (match: (watcher: Watcher) => boolean) => {
    for (const [streamId, view] of viewers) {
      if (!match(view)) continue;
      viewers.delete(streamId);
      screens.end(streamId);
      release(view.workerId, view.projectId, view.userId);
    }
    for (const [socket, follower] of followers) {
      if (!match(follower)) continue;
      followers.delete(socket);
      socket.close(4003, "removed");
    }
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
      if (stopped) return outcome;
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
      let failure: string | null = null;
      try {
        await computers.create({
          id: workerId,
          env: { CHIEFBOT_CONTROL_URL: controlUrlForComputers(), CHIEFBOT_TASK_WORKER_ID: workerId, CHIEFBOT_TASK_WORKER_TOKEN: token },
        });
        await computers.start(workerId);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (stopped) return;
      if (failure !== null) {
        workers.launchFailed(workerId, `Its computer could not start: ${failure}`);
        void workerEnded(workerId);
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
    if (max === undefined || stopped) return;
    for (let token = newToken(), next = workers.dequeue(projectId, max, token); next; token = newToken(), next = workers.dequeue(projectId, max, token)) {
      publish(projectId);
      void launch(projectId, next, token);
    }
  }

  // Removes every worker computer that must go (settle).
  const reap = () => Promise.all(workers.toReap().map(settle));

  // The worker's turn ended: its approvals stop waiting, its computer stops
  // (settle), and its task goes on (workerEnded).
  function turnOver(workerId: TaskWorkerId, turnId: TurnId) {
    approvals.turnEnded(turnId);
    holders.delete(workerId);
    void settle(workerId);
    void workerEnded(workerId);
  }

  // A worker ended by itself: its turn did, or its launch failed. A verifier
  // without a verdict gets BLOCKED first (noVerdict). Then the project's
  // coordinator continues the task, told how the worker ended, in a turn of the
  // chat of the member who requested it (continueTask). Control stopping
  // first, or a BLOCKED report it cannot write (logged), leaves that to
  // recover: callers start this and move on, so it never rejects.
  async function workerEnded(workerId: TaskWorkerId) {
    try {
      await noVerdict(workerId);
    } catch (error) {
      console.error(`could not end ${workerId}:`, error);
      return;
    }
    const worker = workers.worker(workerId);
    if (stopped || !worker) return;
    const verification = projects.tasks(worker.projectId).find(({ number }) => number === worker.taskNumber)?.verification ?? null;
    const continued = workers.continueTask(workerId, continuation(worker, verification?.worker === workerId ? verification : null));
    if (continued === "used_up") publishTasks(worker.projectId);
    else if (continued) onTurnQueued(worker.projectId, continued.userId, continued.event);
  }

  // A verifier that ended (its turn did, or its launch failed) without a verdict
  // gets BLOCKED, so the task shows that nobody checked the pull request. Its
  // summary says why: its error, or its last message. A failed setup step's log,
  // or its stack's failed stage's, is its report. A stopped verifier gets none: someone chose to stop it.
  // Settles once any verdict of the verifier is recorded.
  async function noVerdict(workerId: TaskWorkerId) {
    const worker = workers.worker(workerId);
    if (worker?.kind !== "verifier" || worker.verdict !== null || !["finished", "blocked", "failed"].includes(worker.state)) return;
    const failed = worker.setup.find(({ exitCode }) => exitCode !== 0);
    const stage = workers.transcript(workerId).flatMap(({ event }) => (event.type === "stack-stage" && event.stage.state === "failed" ? [event.stage] : []))[0];
    const log = failed ? { title: `\`${failed.command}\` exited with ${failed.exitCode}:`, text: failed.log } : stage ? { title: `Its stack's ${stage.label} stage failed:`, text: stage.log } : null;
    await recordVerdict(
      workerId,
      {
        result: "blocked",
        summary: worker.state === "finished" ? `It ended without a verdict. Its last message: ${worker.result ?? ""}` : (worker.result ?? "It ended without a verdict."),
        report: log ? [log.title, "", "```", log.text, "```"].join("\n") : "",
      },
      [],
    );
  }

  // Brings the worker's computer to what its record wants: removed when it must
  // go (after any launch still making it), else stopped, keeping its disk, once
  // its turn ended. Only then does its place go to a queued worker. One chore
  // runs per computer: a call while it runs makes it look again after its step.
  // A step that fails is tried again after retryMs, the place held meanwhile.
  function settle(workerId: TaskWorkerId): Promise<void> {
    const running = chores.get(workerId);
    if (running) {
      again.add(workerId);
      return running;
    }
    const chore = (async () => {
      do {
        again.delete(workerId);
        await settleStep(workerId);
      } while (again.has(workerId) && !stopped);
      chores.delete(workerId);
    })();
    chores.set(workerId, chore);
    return chore;
  }

  // One step of settle: the provider call the computer needs, if any, after its
  // stack goes. A computer to stop that is gone already needs none. The record
  // says the computer stopped or went only once both are done.
  async function settleStep(workerId: TaskWorkerId) {
    const goes = workers.mustGo(workerId);
    if (!goes && !workers.stopPending(workerId)) return;
    if (goes) {
      await launches.get(workerId);
      if (stopped) return;
      sockets.get(workerId)?.close();
    }
    holders.delete(workerId);
    try {
      // Its stack lives in the computer's network namespace: it goes first.
      await stacks?.stop(workerId);
      if (goes) await computers.destroy(workerId, { deleteData: true });
      else if ((await computers.status(workerId)) !== "absent") await computers.stop(workerId);
    } catch (error) {
      console.error(`could not ${goes ? "remove" : "stop"} the computer of ${workerId}:`, error);
      if (!stopped) retryLater(workerId);
      return;
    }
    if (stopped) return;
    if (goes) workers.computerRemoved(workerId);
    else workers.computerStopped(workerId);
    const projectId = workers.worker(workerId)?.projectId;
    if (projectId) {
      publish(projectId);
      promote(projectId);
    }
  }

  // Settles the worker's computer again after retryMs, instead of any try already waiting.
  function retryLater(workerId: TaskWorkerId) {
    retries.get(workerId)?.();
    retries.set(
      workerId,
      clock.setTimeout(() => {
        retries.delete(workerId);
        void settle(workerId);
      }, retryMs),
    );
  }

  // Ends the worker's turn (if it runs) and marks its computer to go.
  function stop(workerId: TaskWorkerId, message: string) {
    const ended = workers.stop(workerId, message);
    const turnId = ended[0]?.turnId;
    if (turnId) approvals.turnEnded(turnId);
  }

  // What a worker's brief says of its own copy of the project's template stack
  // (startStack): what runs and how its own service runs, and the template's notes.
  function stackBrief({ config }: Project): string[] {
    const template = stacks && templates.find(({ name }) => name === config.template);
    if (!template || config.service === undefined) return [];
    const dev = config.commands.dev ? ` with \`${config.commands.dev}\`` : "";
    return [
      `Before you started, Chiefbot started the services of the project's template, ${template.title}, on this computer, each on its usual localhost port. This repo is its ${config.service} service: run it from your clone${dev}.`,
      ...template.notes.map((note) => `- ${note}`),
      "",
    ];
  }

  // The engineer's brief, its first message: the task, the project, its stack
  // and how to hand back the work. Its instructions say where its setup cloned the repo.
  function taskPrompt(project: Project, task: Task, instructions: string) {
    const { name, repo, config } = project;
    const commands = Object.entries(config.commands).map(([command, line]) => `- ${command}: ${line}`);
    return [
      `You are an engineer of the project ${name} (GitHub repo ${repo}). You have this computer to yourself for one task. Chiefbot cloned the repo and set it up for you.`,
      "",
      `Task #${task.number}: ${task.title}`,
      ...(task.detail ? [task.detail] : []),
      ...(instructions ? ["", "From the project agent:", instructions] : []),
      "",
      ...(commands.length > 0 ? ["The repo's commands:", ...commands, ""] : []),
      ...stackBrief(project),
      "First reproduce the problem, or see how the code behaves now, on the base branch as cloned, before you change anything.",
      "If nothing needs to change (it is already fixed, or the task only asks a question), push nothing: end with a report of what you checked and what you found.",
      "Otherwise work on a new branch, push it and open a draft pull request with create_pull_request. The member who asked for this approves each push and the pull request.",
      "End with a short summary: the pull request's link and what it changes, or your report.",
    ].join("\n");
  }

  // The verifier's brief, its first message: the task, the pull request at the
  // commit it checks, and how to check it: the repo's verify skill, or the
  // default playbook for a web app when the project sets none. The skill gets
  // the project's dev command and URL too, and every verifier its test
  // command: the app's settings may set them, which the repo does not show.
  // A project with a template gets the verifier a fresh stack, as an engineer's.
  // With a devUrl it checks in the browser, as a pass needs a screenshot
  // (evidenced); without one, by tests and code only. It ends with report_verdict.
  function verifierPrompt(project: Project, task: Task, pr: PullRequestHead & { url: string }, instructions: string) {
    const { name, repo, config } = project;
    const { dev, devUrl, test } = config.commands;
    const app = [...(dev ? [`Start the app with \`${dev}\` in the clone.`] : []), ...(devUrl ? [`It answers at ${devUrl}.`] : [])];
    const start = dev ? `run \`${dev}\` in the background in the clone` : "the project sets no `commands.dev`, so start it as the repo says, in the background";
    const playbook = config.verify
      ? [`Check it as the repo's \`${config.verify}\` skill says: it is among your skills.`, ...(app.length > 0 ? [app.join(" ")] : [])]
      : devUrl
        ? [
            "The repo sets no verify skill, so check it this way:",
            `1. Start the app: ${start}, and wait until ${devUrl} answers.`,
            `2. Open ${devUrl} in Chromium and use the change the pull request describes, as a person would. Then try what it may break nearby.`,
            "3. Save a screenshot of each thing you check: `scrot /tmp/verify-1.png`, then -2, -3 and so on.",
          ]
        : [];
    const evidence = devUrl
      ? "A pass needs at least one screenshot of the app: Chiefbot records a pass with none as blocked."
      : "The project sets no `commands.devUrl`, so there is no app to open: check the change by its tests and by reading the code. Your verdict shows as tests only.";
    return [
      `You are the verifier of the project ${name} (GitHub repo ${repo}). You have this computer to yourself to check one pull request with fresh eyes. You did not write it.`,
      "",
      `Task #${task.number}: ${task.title}`,
      ...(task.detail ? [task.detail] : []),
      "",
      `Pull request: ${pr.url}`,
      `Commit: ${pr.sha}`,
      pr.title,
      ...(pr.body ? [pr.body] : []),
      ...(instructions ? ["", "From the project agent:", instructions] : []),
      "",
      "Chiefbot cloned the repo, checked that commit out and ran the repo's setup.",
      ...stackBrief(project),
      ...playbook,
      evidence,
      ...(test ? [`Run its tests with \`${test}\` in the clone.`] : []),
      "Keep secrets out of your screenshots: no environment pages, and no developer tools that show tokens.",
      "",
      "Change nothing in the repo, and push nothing: Chiefbot refuses a verifier's pushes and pull requests.",
      "End by calling report_verdict once, with your screenshots: pass when the change does what the task asks; issues when it does not, naming each issue; blocked when you could not check it, saying why.",
    ].join("\n");
  }

  // What the worker sets up: the project's config as it is now, and the values
  // of its secrets; a verifier also checks out `sha`. Null when the project is gone.
  async function setupOf(projectId: ProjectId, sha: string | null): Promise<EngineerSetup | null> {
    const project = projects.project(projectId);
    if (!project) return null;
    const { repo, config } = project;
    return { repo, sha, command: config.commands.setup ?? null, instructions: config.instructions, skills: config.skills, mcp: config.mcp, secrets: await secretsFor(projectId) };
  }

  // Starts the worker's own copy of its project's template stack, when the
  // project has a template, before its setup: each stage goes into its
  // transcript as the stack reports it, the stack runner hiding the project's
  // `secrets` and the repo tokens in its log. The project's template keys are
  // checked against the catalog as it is now, and each service's repo against
  // the member who asked (`userId`), on every start: the member who saved the
  // settings being able to read it is not enough, and a cached image is no exception. Null
  // once the stack is ready, or when the project has none; else why the worker
  // is blocked. A stack that started for a worker that ended meanwhile goes again.
  async function startStack(workerId: TaskWorkerId, projectId: ProjectId, userId: UserId, secrets: Record<string, string>): Promise<string | null> {
    const project = projects.project(projectId);
    if (project?.config.template === undefined) return null;
    if (!stacks) return "templates need the local Docker provider";
    const { config } = project;
    const template = templates.find(({ name }) => name === config.template);
    const problem = templateProblem(config, project.repo, templates);
    // templateProblem also checks that the template is in the catalog and the project names its own service.
    if (problem !== null || !template || config.service === undefined) return `Its stack cannot start: ${problem} Fix it in the project's Settings.`;
    const repos: StackPlan["repos"] = {};
    for (const [service, source] of Object.entries(config.services)) {
      if (source === "stand-in") continue;
      const refusal = await repoReadable(userId, source.repo);
      if (refusal) return `Its stack cannot start: services.${service}: ${refusal.message}`;
      const access = await repoReadToken(userId, source.repo).catch(() => null);
      if (access === null || "error" in access) return `Its stack cannot start: services.${service}: GitHub failed while control read ${source.repo}. Try again.`;
      repos[service] = { ...source, token: access.token };
    }
    if (workers.worker(workerId)?.state !== "setting_up") return null;
    let last = "";
    const outcome = await stacks
      .start(workerId, { template, own: config.service, repos, secrets: Object.values(secrets) }, (stage) => {
        last = stage.label;
        const event = workers.stackStage(workerId, { ...stage, at: clock.now() });
        if (event) publish(projectId);
      })
      .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    if (workers.worker(workerId)?.state !== "setting_up") {
      await stacks.stop(workerId).catch((error: unknown) => console.error(`could not remove the stack of ${workerId}:`, error));
      return null;
    }
    // The runner's own failure, not a stage's: its message may hold what the runner was given.
    if (outcome instanceof Error) {
      const tokens = Object.values(repos).flatMap(({ token }) => (token === null ? [] : [token]));
      return `Its stack did not start: ${secretRedactor([...Object.values(secrets), ...tokens]).redact(outcome.message)}`;
    }
    return outcome === "ready" ? null : `Its stack did not start: its ${last} stage failed.`;
  }

  const routes = {
    "/projects/:id/workers": {
      GET: (req: Bun.BunRequest<"/projects/:id/workers">) => {
        const user = store.userForSession(bearer(req));
        if (!user) return unauthorized();
        const found = projects.projectFor(user.id, req.params.id);
        if (!found) return apiError(404, "not_found");
        return Response.json(workersShown(found.project.id) satisfies TaskWorker[]);
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
    // A member watches the worker's screen: control asks its worker to dial back.
    "/projects/:id/workers/:workerId/screen": {
      GET: (req: Bun.BunRequest<"/projects/:id/workers/:workerId/screen">) => {
        const found = memberWorker(req);
        if (found instanceof Response) return found;
        if (!sockets.has(found.worker.id)) return apiError(409, "worker_offline");
        return upgrade(req, { kind: "worker-viewer", workerId: found.worker.id, streamId: crypto.randomUUID(), userId: found.user.id });
      },
    },
    "/projects/:id/workers/:workerId/transcript": {
      GET: (req: Bun.BunRequest<"/projects/:id/workers/:workerId/transcript">) => {
        const found = memberWorker(req);
        if (found instanceof Response) return found;
        const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
        if (!Number.isInteger(after) || after < 0) return apiError(400, "invalid_after");
        return upgrade(req, { kind: "worker-transcript", workerId: found.worker.id, after, userId: found.user.id });
      },
    },
    "/projects/:id/workers/:workerId/take-over": {
      POST: (req: Bun.BunRequest<"/projects/:id/workers/:workerId/take-over">) => drive(req, "take-over"),
    },
    "/projects/:id/workers/:workerId/hand-back": {
      POST: (req: Bun.BunRequest<"/projects/:id/workers/:workerId/hand-back">) => drive(req, "hand-back"),
    },
    // Only a stream control opened for this worker, and only once.
    "/task-worker/:workerId/screen/:streamId": {
      GET: (req: Bun.BunRequest<"/task-worker/:workerId/screen/:streamId">) => {
        const own = ownWorker(req);
        if (own instanceof Response) return own;
        if (!screens.joinable(own.workerId, req.params.streamId)) return apiError(404, "not_found");
        return upgrade(req, { kind: "worker-screen", streamId: req.params.streamId });
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
        if (workers.worker(turn.workerId)?.kind === "verifier") return apiError(403, "verifier_read_only", "A verifier opens no pull request: it ends with report_verdict.");
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
    "/task-worker/:workerId/verdict": {
      POST: async (req: Bun.BunRequest<"/task-worker/:workerId/verdict">) => {
        const turn = heldTurn(store.turnKeys, req, taskWorkerTurn(req.params.workerId));
        if (turn instanceof Response) return turn;
        if (workers.worker(turn.workerId)?.kind !== "verifier") return apiError(403, "not_a_verifier", "Only a verifier reports a verdict.");
        const body = VerdictReport.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_verdict", z.prettifyError(body.error));
        const screenshots = body.data.screenshots.map((base64) => Buffer.from(base64, "base64"));
        if (!screenshots.every((bytes) => isPng(bytes) && bytes.byteLength <= SCREENSHOT_BYTES_MAX)) {
          return apiError(400, "invalid_verdict", "Each screenshot must be a PNG of at most 2 MB.");
        }
        const recorded = await recordVerdict(turn.workerId, body.data, screenshots);
        if (recorded === null) return apiError(409, "verdict_recorded", "A verifier reports one verdict, and yours is recorded.");
        return Response.json(recorded satisfies RecordedVerdict);
      },
    },
  };

  // Records a verifier's verdict, its first only, one at a time per verifier,
  // as the project's devUrl now asks (evidenced). Its report and screenshots go
  // into the project's context first, so they outlive its computer:
  // verify/task-<n>-<commit>-<verifier>.md, with its screenshots beside it as
  // -1.png, -2.png… Then the verdict goes on the worker, and on its task as the
  // task's verification. Null when it has a verdict.
  const recording = queue<TaskWorkerId>();
  function recordVerdict(workerId: TaskWorkerId, given: Omit<VerdictReport, "screenshots">, screenshots: Uint8Array[]) {
    return recording(workerId, async (): Promise<RecordedVerdict | null> => {
      const worker = workers.worker(workerId);
      if (worker?.verdict !== null || worker.sha === null || worker.branch === null || worker.pullRequest === null) return null;
      const { projectId, taskNumber, sha, branch, pullRequest } = worker;
      const verdict = evidenced(given, screenshots.length, projects.project(projectId)?.config.commands.devUrl);
      const name = `task-${taskNumber}-${sha.slice(0, 7)}-${workerId.replace(/^worker_/, "").slice(0, 8)}`;
      const images = screenshots.map((_, at) => `${name}-${at + 1}.png`);
      await Promise.all(screenshots.map((bytes, at) => context.writeImage(projectId, ContextImagePath.parse(`verify/${images[at]}`), bytes)));
      const evidence = ContextPath.parse(`verify/${name}.md`);
      const title = projects.tasks(projectId).find(({ number }) => number === taskNumber)?.title ?? "";
      const at = Date.now();
      await context.write(
        projectId,
        evidence,
        [
          `# Verification of task #${taskNumber}: ${title}`,
          "",
          `**${verdict.result.toUpperCase()}**${verdict.testsOnly ? " (tests only)" : ""} for ${pullRequest} at ${sha} (branch ${branch}), by verifier ${workerId}, ${new Date(at).toISOString()}.`,
          "",
          verdict.summary,
          ...(verdict.report ? ["", "## Report", "", verdict.report] : []),
          ...(images.length > 0 ? ["", "## Screenshots", "", ...images.map((image, index) => `![Screenshot ${index + 1}](${image})`)] : []),
          "",
        ].join("\n"),
      );
      const pinned = workers.setVerdict(workerId, verdict.result);
      if (pinned === null) return null;
      const { result, summary, testsOnly } = verdict;
      projects.setVerdict(projectId, taskNumber, { result, sha, testsOnly, summary, pullRequest, branch, evidence, worker: workerId, at }, pinned.revision);
      publishTasks(projectId);
      publish(projectId);
      return { result, summary, evidence };
    });
  }

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
  // (installationSession.ts). Secrets control cannot read block it: its setup
  // cannot run. So does a stack that cannot start (startStack).
  async function startTask({ id: workerId, projectId, kind, sha }: TaskWorker, userId: UserId) {
    // The connection whose hello started it: the task goes there or nowhere.
    const socket = sockets.get(workerId);
    const run = payerOf({ kind: "project", projectId, askerId: userId });
    const started = run && workers.startTurn(workerId, run.payer);
    if (!run || !started) return;
    const turnKey = store.turnKeys.issue({ agent: "task-worker", workerId, projectId, userId, turnId: started.turnId });
    publish(projectId);
    const connectors = await connectorsFor(projectId, userId).catch(() => []);
    const setup = await setupOf(projectId, sha).catch((error: unknown) => {
      console.error(`could not read the secrets of ${projectId} for ${workerId}: ${secretFailure(error)}`);
      return null;
    });
    if (stopped) return;
    if (!setup) {
      if (workers.end(workerId, "blocked", "Chiefbot could not read the project's secrets, so its setup did not run. Dispatch the task again.").length > 0) {
        turnOver(workerId, started.turnId);
      }
      publish(projectId);
      return;
    }
    const blocked = await startStack(workerId, projectId, userId, setup.secrets);
    if (stopped) return;
    if (blocked !== null) {
      if (workers.end(workerId, "blocked", blocked).length > 0) turnOver(workerId, started.turnId);
      publish(projectId);
      return;
    }
    // The turn may have ended, its member left or its worker reconnected while
    // control read the secrets or started the stack: then they, and the task, go nowhere.
    const live = socket && sockets.get(workerId) === socket && store.turnKeys.holder(turnKey) && store.projects.member(projectId, { userId });
    if (!live) return;
    socket.send(JSON.stringify({ type: "run-task", kind, turnId: started.turnId, turnKey, text: started.prompt, payer: run.payer, connectors, setup } satisfies ControlToWorker));
  }

  // Starts a verifier on the task's pull request (the one named, else the latest
  // the task links), pinned to its head now, read on GitHub as `asker` may, and
  // to the revision of the pushes through Chiefbot to its branch, read before
  // that head (a first read names the branch). Its verdict is stale when a push
  // was in flight then, or one started since.
  // Like an engineer, it takes one of the project's workers.max places, and
  // waits while another worker of the task is unended.
  async function dispatchVerifier(project: Project, asker: ProjectMember, call: Extract<WorkerToolCall, { tool: "dispatch_verifier" }>) {
    const task = projects.tasks(project.id).find(({ number }) => number === call.task);
    if (!task) return refused(`No task #${call.task} in this project`, 404);
    if (task.status === "done" || task.status === "abandoned") return refused(`Task #${task.number} is ${task.status}`);
    const linked = task.links.flatMap((link) => (link.kind === "pull-request" ? [link.url] : []));
    const url = call.pullRequest ?? linked.at(-1);
    if (url === undefined) return refused(`Task #${task.number} links no pull request: an engineer opens one first, and a verifier checks it.`);
    if (!linked.includes(url)) return refused(`Task #${task.number} does not link ${url}: add it with update_task first.`);
    const number = pullRequestNumber(url, project.repo);
    if (number === null) return refused(`${url} is not a pull request of ${project.repo}.`);
    const first = await pullRequestHead(asker.userId, project.repo, number);
    if ("error" in first) return refused(`Couldn't read ${url} on GitHub: ${first.message}`, 502);
    const pushes = projects.pushesTo(project.repo, first.branch);
    const head = await pullRequestHead(asker.userId, project.repo, number);
    if ("error" in head) return refused(`Couldn't read ${url} on GitHub: ${head.message}`, 502);
    const revision = pushes.active === 0 && head.branch === first.branch ? pushes.revision : null;
    const token = newToken();
    const record = workers.launch({
      projectId: project.id,
      taskNumber: task.number,
      creationId: call.creationId,
      userId: asker.userId,
      prompt: verifierPrompt(project, task, { ...head, url }, call.instructions),
      token,
      max: project.config.workers.max,
      verifies: { pullRequest: url, sha: head.sha, branch: head.branch, revision },
    });
    return launched(project, task, record, token);
  }

  // Answers a dispatch with its worker once its launch is under way: a new one
  // launches now unless queued, and a resent call waits for the first one's launch.
  async function launched(project: Project, task: Task, record: ReturnType<typeof workers.launch>, token: string) {
    if ("busy" in record) return refused(`Worker ${record.busy.id} still works on task #${task.number}: stop it first, or wait for it`, 409);
    const { id } = record.worker;
    if (record.launched) publish(project.id);
    if (record.launched && record.worker.state === "launching") await launch(project.id, id, token);
    else await launches.get(id);
    return Response.json(workers.worker(id) satisfies TaskWorker | null);
  }

  // The signed-in member and the project's worker :workerId; 401 or 404 otherwise.
  function memberWorker(req: Request & { params: { id: string; workerId: string } }) {
    const user = store.userForSession(bearer(req));
    if (!user) return unauthorized();
    const found = projects.projectFor(user.id, req.params.id);
    const worker = found && workers.workerIn(found.project.id, req.params.workerId);
    if (!worker) return apiError(404, "not_found");
    return { user, worker };
  }

  // Take-over and hand-back of the worker's screen. One member drives at a time,
  // from a view of the screen they have open; only they hand it back.
  function drive(req: Request & { params: { id: string; workerId: string } }, action: "take-over" | "hand-back") {
    const found = memberWorker(req);
    if (found instanceof Response) return found;
    const { user, worker } = found;
    const holder = holders.get(worker.id);
    if (holder && holder.userId !== user.id) return apiError(409, "screen_taken");
    if (action === "take-over" && !holder) {
      if (!watching(worker.id, user.id)) return apiError(409, "screen_not_open");
      holders.set(worker.id, { userId: user.id, login: user.login });
      screenChanged(worker.id, worker.projectId);
    }
    if (action === "hand-back") release(worker.id, worker.projectId, user.id);
    return Response.json({ ...worker, screenHolder: holders.get(worker.id)?.login ?? null } satisfies TaskWorker);
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

    // The done rule: the project agent marks a task done only with a verifier's
    // PASS for the head of its pull request (its latest, `links` added), read
    // again on GitHub as `asker` may, so a push from anywhere counts: the
    // verification's `stale` follows what it finds. A task that links no pull
    // request has nothing to verify, and one already done stays so unless it
    // gets a new pull request. Answers why not (`refused`), or what the done
    // write must find unchanged (`verified`, projectStore.ts completeTask): the
    // head GitHub showed, and the revision of the pushes through Chiefbot to its
    // branch, read before GitHub, none in flight. A stale PASS stays stale: only
    // a new verifier's verdict is current.
    // A member may mark it done over this in the app (projects.ts).
    async doneCheck(project: Project, asker: ProjectMember, number: number, links: TaskLink[] = []): Promise<{ refused: string } | { verified?: VerifiedHead }> {
      const task = projects.tasks(project.id).find((candidate) => candidate.number === number);
      const url = latestPullRequest([...(task?.links ?? []), ...links]);
      if (!task || url === undefined || (task.status === "done" && url === latestPullRequest(task.links))) return {};
      const refused = (why: string) => ({ refused: notDone(why) });
      const { verification } = task;
      if (verification?.pullRequest !== url) return refused(`Task #${number} needs a verifier's PASS for ${url} at its head before it is done: dispatch_verifier first.`);
      const at = verification.sha.slice(0, 7);
      if (verification.result === "issues") return refused(`Task #${number} is not done: its verifier found issues in ${url} at ${at}. ${verification.summary}`);
      if (verification.result === "blocked") return refused(`Task #${number} is not done: its verifier could not check ${url} at ${at}. ${verification.summary}`);
      if (verification.stale) return refused(`Task #${number} is not done: its PASS for ${at} is stale, as a push may have moved ${url} since. Dispatch a verifier again.`);
      const pushes = projects.pushesTo(project.repo, verification.branch);
      if (pushes.active > 0) return { refused: movedWhileChecking(number) };
      const prNumber = pullRequestNumber(url, project.repo);
      const head = prNumber === null ? null : await pullRequestHead(asker.userId, project.repo, prNumber);
      if (head === null || "error" in head) {
        return refused(`Task #${number} is not done: Chiefbot couldn't read ${url} on GitHub to check that its PASS is for its head${head ? ` (${head.message})` : ""}. Try again.`);
      }
      if (head.sha !== verification.sha) {
        if (projects.markStale(project.id, number, verification.worker)) publishTasks(project.id);
        return refused(`Task #${number} is not done: its PASS is for ${at}, and ${url} has moved to ${head.sha.slice(0, 7)} since. Dispatch a verifier again.`);
      }
      if (head.branch !== verification.branch) return { refused: movedWhileChecking(number) };
      return { verified: { pullRequest: url, sha: head.sha, revision: pushes.revision } };
    },

    // A push through the git proxy is about to move `branches` of `repo`
    // (repos.ts): they count it in flight until it ends. Then each verdict on a
    // branch it moved, at another commit, is stale; when GitHub's answer was
    // lost (`moved` null), each verdict on its branches (projectStore.ts pushEnded).
    pushing(repo: string, branches: string[]) {
      projects.pushStarted(repo, branches);
      return (moved: Array<{ branch: string; sha: string }> | null) => {
        for (const projectId of projects.pushEnded(repo, branches, moved)) publishTasks(projectId);
      };
    },

    // For the git proxy: the worker's turn as a repo agent; a verifier's only fetches its project's repo.
    repoAgentOf(turn: TaskWorkerTurn): RepoAgent | RepoReader | null {
      if (workers.worker(turn.workerId)?.kind !== "verifier") return agentOf(turn);
      const repo = projects.project(turn.projectId)?.repo;
      return repo ? { userId: turn.userId, repo, who: "A verifier" } : null;
    },

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
        return launched(project, task, record, token);
      }
      if (call.tool === "dispatch_verifier") return dispatchVerifier(project, asker, call);
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

    // The member left the workspace or was removed: their screens and
    // transcripts close at once, any screen they drove goes back to the agent,
    // and the workers they asked for stop and their computers go.
    memberRemoved(workspaceId: WorkspaceId, userId: UserId) {
      const inWorkspace = new Set(projects.projectsIn(workspaceId).map(({ id }) => id));
      closeWatchers((watcher) => watcher.userId === userId && inWorkspace.has(watcher.projectId));
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

    // The project is being deleted: every member's screens and transcripts of
    // it close, its workers stop and every computer of theirs goes now. Throws
    // when one cannot be removed, so nothing is deleted.
    async removeProject(projectId: ProjectId) {
      closeWatchers((watcher) => watcher.projectId === projectId);
      for (const workerId of workers.running(projectId)) stop(workerId, "The project was deleted.");
      for (const workerId of workers.toReap(projectId)) {
        await launches.get(workerId);
        sockets.get(workerId)?.close();
        await stacks?.stop(workerId);
        await computers.destroy(workerId, { deleteData: true });
        workers.computerRemoved(workerId);
      }
    },

    // On control's start: every approval a worker waits on gets its wait limit
    // again. A worker still launching whose computer is not running lost its
    // launch to the restart, so it fails. Each worker that ended and has not
    // continued its task does. Each worker whose turn ended but whose computer
    // was not recorded stopped settles, whatever the computer's state: one that
    // stopped on its own, as at a host restart, may have left its stack. Then
    // every worker computer that should be gone is removed, and queued workers
    // launch where there is room.
    async recover() {
      for (const { workerId, approvalId, requestedAt } of workers.waitingApprovals()) limitWait(workerId, approvalId, requestedAt);
      for (const workerId of workers.launching()) {
        const status = await computers.status(workerId);
        if (stopped) return;
        if (status !== "running") workers.launchFailed(workerId, "Control restarted before its computer was ready.");
      }
      for (const workerId of workers.uncontinued()) void workerEnded(workerId);
      for (const workerId of workers.ended()) {
        if (stopped) return;
        await settle(workerId);
      }
      await reap();
      for (const projectId of workers.queuedProjects()) promote(projectId);
    },

    // Control is stopping: no wait limit or computer retry fires any more, and
    // nothing new starts.
    stop() {
      stopped = true;
      for (const cancel of [...waitLimits.values(), ...retries.values()]) cancel();
      waitLimits.clear();
      retries.clear();
    },

    open(ws: Socket, { workerId }: TaskWorkerSocketData) {
      // One connection per worker: a reconnecting worker replaces its stale socket.
      sockets.get(workerId)?.close(4000, "replaced");
      sockets.set(workerId, ws);
      ws.send(JSON.stringify({ type: "bound" } satisfies ControlToWorker));
      ws.send(JSON.stringify({ type: "screen-control", control: controlOf(workerId) } satisfies ControlToWorker));
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
        sendTranscripts((follower) => follower.workerId === workerId);
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
      const needs = worker.kind === "verifier" ? [ENGINEER_SETUP, VERIFIER] : [ENGINEER_SETUP];
      if (worker.state === "launching" && !needs.every((capability) => message.capabilities.includes(capability))) {
        if (workers.end(workerId, "blocked", outdatedImage(worker.kind)).length > 0) turnOver(workerId, turnId);
        publish(worker.projectId);
      } else if (worker.state === "launching") {
        void startTask(worker, userId);
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

    // A socket watching a worker opened: a transcript's follower gets what it
    // has not had; a viewer waits while its worker dials back; the worker's end
    // joins the viewer's stream.
    watchOpen(ws: Socket, data: WorkerWatchSocketData) {
      if (data.kind === "worker-screen") {
        if (!screens.joinScreen(data.streamId, ws)) ws.close();
        return;
      }
      const projectId = workers.worker(data.workerId)?.projectId;
      if (!projectId) return ws.close();
      const watcher = { workerId: data.workerId, projectId, userId: data.userId };
      if (data.kind === "worker-transcript") {
        followers.set(ws, { ...watcher, after: data.after });
        sendTranscripts((follower) => follower === followers.get(ws));
        return;
      }
      if (!sockets.has(data.workerId)) return ws.close();
      viewers.set(data.streamId, { ...watcher, pass: viewerBytes() });
      screens.openViewer(data.workerId, data.streamId, ws);
      send(data.workerId, { type: "screen-open", streamId: data.streamId });
    },

    // A closed view of the screen ends its stream; the member's last one hands
    // back any control they held.
    watchClose(ws: Socket, data: WorkerWatchSocketData) {
      if (data.kind === "worker-transcript") return void followers.delete(ws);
      screens.end(data.streamId);
      const view = data.kind === "worker-viewer" && viewers.get(data.streamId);
      if (!view) return;
      viewers.delete(data.streamId);
      if (!watching(view.workerId, view.userId)) release(view.workerId, view.projectId, view.userId);
    },

    // A transcript's follower sends nothing; a screen's ends pipe bytes to each
    // other, a viewer's input only while its member drives the screen.
    watchMessage(data: WorkerWatchSocketData, raw: string | Buffer) {
      if (data.kind === "worker-transcript") return;
      if (data.kind === "worker-screen") return screens.relay(data.streamId, "screen", raw);
      const view = viewers.get(data.streamId);
      if (!view) return;
      const bytes = view.pass(typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw), holders.get(view.workerId)?.userId === view.userId);
      if (bytes === null) return screens.end(data.streamId);
      if (bytes.length > 0) screens.relay(data.streamId, "viewer", Buffer.from(bytes));
    },
  };
}

// The verdict control records for one a verifier gave with `shots` screenshots,
// on a project whose app answers at `devUrl`, if it sets one: there, a pass
// with no screenshot is blocked, for no browser evidence. A pass or issues that
// no screenshot backs is tests only (VerdictLine).
function evidenced(verdict: Omit<VerdictReport, "screenshots">, shots: number, devUrl: string | undefined) {
  if (verdict.result === "pass" && shots === 0 && devUrl !== undefined) {
    const summary = `No browser evidence: a PASS needs a screenshot of the app at ${devUrl}. The verifier said: ${verdict.summary}`;
    return { ...verdict, result: "blocked" as const, summary, testsOnly: false };
  }
  return { ...verdict, testsOnly: verdict.result !== "blocked" && shots === 0 };
}

// Why the project agent may not mark a task done (the done rule), as it reads it.
const notDone = (why: string) => `${why} A member can still mark it done in the app.`;

// What the project's coordinator is told when one of a task's workers ended by
// itself (workerEnded): how it ended, a verifier's with its verdict
// (`verification`, when the task's is its), and what to do next.
function continuation(worker: TaskWorker, verification: Verification | null) {
  const how =
    worker.kind === "verifier"
      ? verification
        ? `${verification.result.toUpperCase()} for ${verification.pullRequest} at ${verification.sha.slice(0, 7)}${verification.stale ? " (stale: the branch moved since)" : ""}: ${verification.summary}`
        : `${worker.state} without a verdict: ${worker.result ?? "no reason given"}`
      : worker.state !== "finished"
        ? `${worker.state}: ${worker.result ?? "no reason given"}`
        : worker.pullRequest
          ? `opened ${worker.pullRequest}`
          : "finished without opening a pull request (worker_status has its report)";
  const role = worker.kind === "verifier" ? "Verifier" : "Engineer";
  return `${role} for task #${worker.taskNumber} ended: ${how.trim().replace(/\.$/, "")}. Continue the task: dispatch the verifier on its PR, send fixes for ISSUES, or mark it done after a current PASS.`;
}

// The done rule's answer when task `number`'s pull request or its verdict moved while control checked it.
export const movedWhileChecking = (number: number) =>
  notDone(`Task #${number} is not done: its pull request moved while Chiefbot checked it. Verify it again.`);

// Why a worker whose computer cannot do its kind of task (no ENGINEER_SETUP, or a
// verifier's VERIFIER, in its hello) is blocked.
const outdatedImage = (kind: TaskWorker["kind"]) =>
  kind === "verifier"
    ? "Its computer runs an older Chiefbot image, which cannot run a verifier. Rebuild the computer image (`bun run computer:build`), then dispatch the verifier again."
    : "Its computer runs an older Chiefbot image, which cannot set up an engineer. Rebuild the computer image (`bun run computer:build`), then dispatch the task again.";

// How long control waits to try again to stop or remove a worker's computer.
const retryMs = 30_000;

// The number of a pull request of `repo` from its page's URL (GitHub's html_url), or null.
function pullRequestNumber(url: string, repo: string): number | null {
  const [, fullName, number] = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(new URL(url).pathname) ?? [];
  return fullName?.toLowerCase() === repo.toLowerCase() && number ? Number(number) : null;
}

// A worker's turn as transcript lines for the coordinator: each stage of its
// stack that ended and each setup step with its exit code (and its log when it
// failed), each message whole, each tool call
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
      case "stack-stage": {
        const { label, state, log } = event.stage;
        if (state !== "running") lines.push(`stack ${label}: ${state}${state === "failed" ? `\n${log}` : ""}`);
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
