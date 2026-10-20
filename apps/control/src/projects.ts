import {
  AUTO_MODEL,
  AnswerApprovalRequest,
  ContextImagePath,
  ContextPath,
  CoordinatorToControl,
  CoordinatorToolCall,
  CreateProjectRequest,
  ProjectSettingsRequest,
  projectState,
  SecretName,
  SendMessageRequest,
  SetBotModelRequest,
  SetProjectSecretRequest,
  supportedEffort,
  type AgentConnector,
  type ApprovalKind,
  type ChatEvent,
  type ClientEvent,
  type ContextFile,
  type ContextFileText,
  type ControlToCoordinator,
  type AutoFallback,
  type CopilotPayer,
  type Project,
  type ProjectId,
  type ProjectMember,
  type ProjectSecret,
  type ProjectState,
  type SendMessageResponse,
  type Task,
  type User,
  type UserId,
  type WorkspaceId,
} from "@chiefbot/contracts";
import type { ApprovalOutcome, controlApprovals } from "./approvals.ts";
import type { ComputerProvider } from "./computers/computer.ts";
import type { ContextStore } from "./contextStore.ts";
import { apiError, bearer, unauthorized } from "./http.ts";
import { modelOptions, pickModel } from "./models.ts";
import { parseProjectFile, readProjectFile } from "./projectFile.ts";
import { queue } from "./queue.ts";
import type { repoAccess } from "./repos.ts";
import { secretFailure, type SecretStore } from "./secrets/secretStore.ts";
import type { openStore } from "./store.ts";
import type { copilotIdentity, CopilotToken } from "./copilotIdentity.ts";
import { movedWhileChecking, type taskWorkerHost } from "./taskWorkers.ts";
import { coordinatorTurn, heldTurn, type CoordinatorTurn } from "./turnKeys.ts";

// What a project WebSocket is bound to: a project's coordinator, or one
// member's chat with it from `after` on.
export type ProjectSocketData =
  | { kind: "coordinator"; projectId: ProjectId }
  | { kind: "project-chat"; projectId: ProjectId; userId: UserId; after: number };

// The slice of a Bun ServerWebSocket this module uses.
type Socket = { send(message: string): unknown; close(code?: number, reason?: string): void; subscribe(topic: string): void };

export type ProjectHostOptions = {
  store: ReturnType<typeof openStore>;
  // Who pays for each coordinator turn (copilotIdentity.ts).
  payerOf: ReturnType<typeof copilotIdentity>;
  computers: ComputerProvider;
  context: ContextStore;
  // Where the values of the projects' secrets live.
  secrets: SecretStore;
  // The projects' task workers (taskWorkers.ts): the coordinator's worker tools.
  workers: ReturnType<typeof taskWorkerHost>;
  // Approvals control asks for in a coordinator turn (a connector call).
  approvals: ReturnType<typeof controlApprovals>;
  githubApiUrl: string;
  // A token to read a repo for a user, or why not (repos.ts readToken).
  repoReadToken: ReturnType<typeof repoAccess>["readToken"];
  // Control's URL as a computer reaches it.
  controlUrlForComputers: () => string;
  // Publishes to a WebSocket topic.
  publish: (topic: string, message: string) => void;
  // Sends a ClientEvent to every /events socket of the user.
  publishToUser: (userId: UserId, event: ClientEvent) => void;
  // Upgrades the request to a project WebSocket; undefined once upgraded.
  upgrade: (req: Request, data: ProjectSocketData) => Response | undefined;
  // The connectors a member's coordinator session gets for a turn (connectors/connectors.ts).
  connectorsFor: (projectId: ProjectId, userId: UserId) => Promise<AgentConnector[]>;
  // The project's task ledger changed.
  onLedgerChange: (projectId: ProjectId) => void;
  // The project's state may have changed for its members (contracts projectState):
  // its agent woke, slept or got a message to answer.
  onStateChange: (projectId: ProjectId) => void;
  // The project was deleted: these were its members.
  onDeleted: (memberIds: UserId[]) => void;
  // The coordinator did something: its idle time starts again (idle.ts).
  onActivity: (projectId: ProjectId) => void;
};

// A new SecretStore name for a project secret's value being written: each value
// gets its own, so two writes never touch the same one.
const newSecretName = (projectId: ProjectId) => `project-${projectId}-${crypto.randomUUID()}`;

// Projects: a workspace's repos, each with a coordinator on its own computer
// (from the ComputerProvider), a task ledger and shared context in control,
// and one chat with the coordinator per member. The project's scheduler runs
// one coordinator turn at a time across all members' chats, oldest first, so
// each turn sees every task the turns before it made. Control stops an idle
// coordinator's computer (`sleep`, from idle.ts); a turn queued for it starts the computer again.
//
// Member routes (a session; 404 to anyone outside the project's workspace):
//   GET    /workspaces/:id/projects  → Project[]
//   POST   /workspaces/:id/projects  body CreateProjectRequest → 201 Project. Control reads the repo's
//                                    chiefbot.project.yaml through the repo app, if the user may read it
//                                    (404 repo_not_found; 403 reauth_needed; 409 project_exists), then starts
//                                    the coordinator's computer. No file, or an invalid one, still makes the
//                                    project: Project.file says so, and the settings alone make its config.
//   GET    /projects/:id             → Project
//   DELETE /projects/:id             → 204 (workspace owner only): its computer, its workers' computers,
//                                    ledger, chats, context, settings and secrets go, once the secret
//                                    writes already asked for are done
//   PUT    /projects/:id/settings    body ProjectSettingsRequest → Project with the new config (400
//                                    invalid_settings says what is wrong)
//   PUT    /projects/:id/model       body SetBotModelRequest → Project: the coordinator's next turn runs on
//                                    it (400 model_unavailable when the member's plan does not offer it or it is
//                                    locked, effort_unavailable when the model does not support the effort)
//   GET    /projects/:id/secrets     → ProjectSecret[]: names, never a value
//   PUT    /projects/:id/secrets/:name  body SetProjectSecretRequest → 204, for a name the config declares
//                                    (400 invalid_secret; 503 secrets_unavailable)
//   DELETE /projects/:id/secrets/:name  → 204: its value goes
//   GET    /projects/:id/tasks       → Task[]: the ledger. Every change also reaches each member's /events
//                                    as a `tasks` ClientEvent.
//   POST   /projects/:id/tasks/:number/done  → Task: the member marks it done, over the done rule
//                                    (taskWorkers.ts doneCheck), recorded in its `overrides`
//                                    (404 not_found; 409 task_closed when it is done or abandoned)
//   GET    /projects/:id/context     → ContextFile[]: the shared context's files
//   GET    /projects/:id/context/file  ?path=<ContextPath> → ContextFileText (400 invalid_path; 404 not_found)
//   GET    /projects/:id/context/image ?path=<ContextImagePath> → the PNG's bytes (400 invalid_path; 404 not_found)
//   POST   /projects/:id/approvals/:approvalId  body AnswerApprovalRequest → 204: the member answers
//                                    what control asked in their running turn (409 not_pending when it
//                                    is answered, unknown, another member's or its turn ended)
//   POST   /projects/:id/messages    body SendMessageRequest → 202 SendMessageResponse: queued for the
//                                    coordinator (409 turn_running while the member's last one is unfinished)
//   WS     /projects/:id/chat        ?after=<seq> → each ChatEvent of the member's own chat after seq, then live ones
// Coordinator routes. The WebSocket takes the project's credential (403 for another project's); every
// other route takes the key of one of the project's running turns (403 invalid_turn_key otherwise), and
// acts only as that turn's member, in that turn:
//   WS     /coordinator/:projectId   ControlToCoordinator; CoordinatorToControl back
//   GET    /coordinator/:projectId/github-token  → BrokeredGitHubToken of the turn's member, when their
//                                    seat pays for it (404 when the organization pays; 403 reauth_needed)
//   GET    /coordinator/:projectId/installation-token  → CopilotInstallationToken, when the organization
//                                    pays for the turn (404 otherwise; 502 copilot_token_failed)
//   POST   /coordinator/:projectId/tools  body CoordinatorToolCall → its answer (see projects.ts in contracts)
export function projectHost({
  store,
  payerOf,
  computers,
  context,
  secrets,
  workers,
  approvals,
  githubApiUrl,
  repoReadToken,
  controlUrlForComputers,
  publish,
  publishToUser,
  upgrade,
  connectorsFor,
  onLedgerChange,
  onStateChange,
  onDeleted,
  onActivity,
}: ProjectHostOptions) {
  const { projects } = store;
  // Each member's open chat sockets, by project and member.
  const chatSockets = new Map<string, Set<Socket>>();
  // Each project's connected coordinator, and the projects whose coordinator has said hello.
  const coordinators = new Map<ProjectId, Socket>();
  const greeted = new Set<ProjectId>();
  // Projects whose computer control is stopping (no turn may land on it), and those it is starting.
  const stopping = new Set<ProjectId>();
  const waking = new Set<ProjectId>();
  // A project's secret writes and clears, and its deletion, run one at a time, in order.
  const inOrder = queue<ProjectId>();

  // Deletes leftover secret values (projectStore) from the SecretStore. One it
  // refuses stays a leftover, logged, and goes when control next starts.
  const forget = (secretNames: string[]) =>
    Promise.all(
      secretNames.map(async (secretName) => {
        try {
          await secrets.delete(secretName);
          // Secret Manager answers a delete of a secret it does not find as done
          // (secretManager.ts), and it is eventually consistent: a value written
          // just before may still be there after its record goes (docs/deploy.md).
          projects.secretDeleted(secretName);
        } catch (error) {
          console.error(`could not delete the project secret value ${secretName}: ${secretFailure(error)}`);
        }
      }),
    );
  // What writes and deletes left before control stopped, or failed to delete.
  void forget(projects.secretLeftovers());

  const chatTopic = (projectId: ProjectId, userId: UserId) => `project-chat:${projectId}:${userId}`;
  const publishChat = (projectId: ProjectId, { userId, event }: { userId: UserId; event: ChatEvent }) =>
    publish(chatTopic(projectId, userId), JSON.stringify(event satisfies ChatEvent));
  const publishTasks = (projectId: ProjectId) => {
    const tasks = projects.tasks(projectId);
    for (const userId of projects.memberIds(projectId)) publishToUser(userId, { type: "tasks", projectId, tasks });
    onLedgerChange(projectId);
  };
  // Ends the project's queued continuations of tasks done or abandoned (a
  // member's Mark done, the coordinator's done), so none reopens its task.
  const endClosedContinuations = (projectId: ProjectId) => {
    for (const ended of projects.endClosedContinuations(projectId)) publishChat(projectId, ended);
  };
  // The task is done or abandoned: its workers stop, and its queued continuations end.
  const taskClosed = (projectId: ProjectId, taskNumber: number) => {
    workers.taskClosed(projectId, taskNumber);
    endClosedContinuations(projectId);
  };
  const toCoordinator = (projectId: ProjectId, message: ControlToCoordinator) =>
    coordinators.get(projectId)?.send(JSON.stringify(message));

  // The project's scheduler: once its coordinator is ready, hands it the oldest
  // queued turn, unless a turn is running (the store's claim refuses then), with
  // the project's model (at its effort while the member's plan still offers it
  // for the model), who pays for its Copilot and the connectors ready for that turn's member.
  // The turn's chat says who pays. Connectors act as the member (or the
  // workspace, for a shared one) whoever pays: org billing changes only
  // Copilot's identity. If they cannot be read, the turn runs without connectors.
  // A queued continuation of a task closed meanwhile ends unclaimed.
  const schedule = (projectId: ProjectId) => {
    onStateChange(projectId);
    if (stopping.has(projectId)) return;
    endClosedContinuations(projectId);
    if (!greeted.has(projectId)) return wake(projectId);
    const next = projects.claimNextTurn(projectId);
    const run = next && payerOf({ kind: "project", projectId, askerId: next.member.userId });
    const project = projects.project(projectId);
    if (!next || !run || !project) return;
    const { fallback, ...model } = turnModel(project, run.payer, next.member.userId);
    const turnKey = store.turnKeys.issue({ agent: "coordinator", projectId, userId: next.member.userId, turnId: next.turnId });
    publishChat(projectId, projects.addPayer(next.turnId, run.payer, fallback));
    void connectorsFor(projectId, next.member.userId)
      .catch(() => [])
      .then((connectors) => toCoordinator(projectId, { type: "run-turn", ...next, ...model, turnKey, payer: run.payer, connectors }));
  };

  // The model and effort a turn of the project runs on: the project's, as far as
  // the plan of who pays offers them (the member's on their seat, the
  // organization's on its billing, as their turns last listed them), else Auto.
  // `fallback` then says why, for the turn's payer line.
  const turnModel = (project: Project, payer: CopilotPayer, userId: UserId) => {
    const report = payer.kind === "seat" ? store.modelReport(userId) : store.orgModelReport(payer.account);
    const options = modelOptions(report, payer.kind === "seat" ? store.user(userId).copilotPlan : null);
    const offered = options.find(({ id, lockedReason }) => id === project.model && lockedReason === null);
    if (offered) return { model: project.model, effort: supportedEffort(offered.efforts, project.effort), fallback: null };
    const model = options.find(({ id }) => id === project.model)?.name ?? project.model;
    return { model: AUTO_MODEL, effort: null, fallback: { model, reason: report ? "not_on_plan" : "plan_unknown" } satisfies AutoFallback };
  };
  // The model picker's rows for the user's Copilot plan (models.ts).
  const modelOptionsOf = (user: User) => modelOptions(store.modelReport(user.id), user.copilotPlan);

  // Starts the project's computer when a turn waits and no coordinator is
  // connected: it was stopped for idleness. A no-op for a computer still running.
  const wake = (projectId: ProjectId) => {
    if (coordinators.has(projectId) || waking.has(projectId) || !projects.hasQueuedTurn(projectId)) return;
    waking.add(projectId);
    computers
      .start(projectId)
      .catch((error: unknown) => console.error(`could not start the computer of ${projectId}:`, error))
      .finally(() => waking.delete(projectId));
  };

  // The Copilot token of the turn the request's key holds, if its payer is of
  // `kind`; 404 otherwise: a coordinator gets no one else's.
  const turnToken = async (req: Request & { params: { projectId: string } }, kind: CopilotPayer["kind"]) => {
    const turn = heldTurn(store.turnKeys, req, coordinatorTurn(req.params.projectId));
    if (turn instanceof Response) return turn;
    const run = payerOf({ kind: "project", projectId: turn.projectId, askerId: turn.userId });
    if (!run || run.payer.kind !== kind) return apiError(404, "not_found");
    const token: CopilotToken = await run.token();
    if ("error" in token) return token.error === "reauth_needed" ? apiError(403, token.error) : apiError(502, token.error, token.message);
    return Response.json(token.token);
  };

  // Runs a /projects/:id route for a signed-in member of the project's workspace; 401 or 404 otherwise.
  const member =
    <Req extends Request & { params: { id: string } }>(
      handle: (user: User, found: { project: Project; owner: boolean }, req: Req) => Response | undefined | Promise<Response | undefined>,
    ) =>
    (req: Req) => {
      const user = store.userForSession(bearer(req));
      if (!user) return unauthorized();
      const found = projects.projectFor(user.id, req.params.id);
      if (!found) return apiError(404, "not_found");
      return handle(user, found, req);
    };

  // The project whose credential the request carries, if it is :projectId's; 401 or 403 otherwise.
  // Only the WebSocket takes it: every other coordinator route takes a turn key.
  const ownCoordinator = (req: Request & { params: { projectId: string } }) => {
    const projectId = projects.projectForToken(bearer(req));
    if (!projectId) return unauthorized();
    if (projectId !== req.params.projectId) return apiError(403, "wrong_bot");
    return projectId;
  };

  // Makes the project's computer and starts its coordinator.
  async function startComputer(projectId: ProjectId, token: string) {
    await computers.create({
      id: projectId,
      env: { CHIEFBOT_CONTROL_URL: controlUrlForComputers(), CHIEFBOT_PROJECT_ID: projectId, CHIEFBOT_PROJECT_TOKEN: token },
    });
    await computers.start(projectId);
  }

  // One coordinator tool call, made in the turn of `asker`. Answers the call's
  // result as JSON, or a refusal the model sees.
  async function runTool(project: Project, asker: ProjectMember, call: CoordinatorToolCall): Promise<Response> {
    const projectId = project.id;
    // A task's owner is named by login; it must be a member's.
    const ownerLogin = (owner: string | null | undefined) => {
      if (owner === null || owner === undefined) return { login: owner };
      const found = projects.member(projectId, { login: owner });
      return found ? { login: found.login } : null;
    };
    const notMember = (owner: string) => apiError(400, "invalid_tool_call", `${owner} is not a member of this project's workspace`);
    switch (call.tool) {
      case "create_task": {
        const owner = ownerLogin(call.owner);
        if (!owner) return notMember(String(call.owner));
        const task = projects.createTask(projectId, { ...call, owner: owner.login ?? null }, asker.login);
        publishTasks(projectId);
        return Response.json(task satisfies Task);
      }
      case "update_task": {
        const owner = ownerLogin(call.owner);
        if (!owner) return notMember(String(call.owner));
        const { status, ...change } = { ...call, owner: owner.login };
        // Done goes through the done rule: checked against GitHub, then written
        // only if what it checked is unchanged (projectStore.ts completeTask).
        const check = status === "done" ? await workers.doneCheck(project, asker, call.number, call.links) : null;
        if (check && "refused" in check) return apiError(400, "invalid_tool_call", check.refused);
        const task = status === "done" ? projects.completeTask(projectId, change, check?.verified) : projects.updateTask(projectId, { ...change, status });
        if (task === "moved") return apiError(400, "invalid_tool_call", movedWhileChecking(call.number));
        if (!task) return apiError(404, "not_found", `No task #${call.number} in this project`);
        publishTasks(projectId);
        if (task.status === "done" || task.status === "abandoned") taskClosed(projectId, task.number);
        return Response.json(task satisfies Task);
      }
      case "list_tasks":
        return Response.json(projects.tasks(projectId, call.status) satisfies Task[]);
      case "read_context": {
        if (!call.path) return Response.json((await context.list(projectId)) satisfies ContextFile[]);
        const content = await context.read(projectId, call.path);
        if (content === null) return apiError(404, "not_found", `No context file ${call.path}`);
        return Response.json({ path: call.path, content });
      }
      case "write_context":
        return Response.json((await context.write(projectId, call.path, call.content)) satisfies ContextFile);
      case "dispatch_worker":
      case "dispatch_verifier":
      case "worker_status":
      case "worker_transcript":
      case "stop_worker":
        return workers.tool(project, asker, call);
    }
  }

  // The project's secrets as members see them: the names its config declares,
  // then any value left whose name it no longer declares. Never a value.
  const secretsOf = (project: Project): ProjectSecret[] => {
    const held = new Set(projects.secretNames(project.id));
    const declared = project.config.secrets.map((name) => ({ name, declared: true, set: held.has(name) }));
    const left = [...held].filter((name) => !project.config.secrets.includes(name)).map((name) => ({ name, declared: false, set: true }));
    return [...declared, ...left];
  };

  const routes = {
    "/workspaces/:id/projects": {
      GET: (req: Bun.BunRequest<"/workspaces/:id/projects">) => {
        const user = store.userForSession(bearer(req));
        if (!user) return unauthorized();
        const workspace = store.workspaces.workspaceFor(user.id, req.params.id);
        if (!workspace) return apiError(404, "not_found");
        return Response.json(projects.projectsIn(workspace.id) satisfies Project[]);
      },
      POST: async (req: Bun.BunRequest<"/workspaces/:id/projects">) => {
        const user = store.userForSession(bearer(req));
        if (!user) return unauthorized();
        const workspace = store.workspaces.workspaceFor(user.id, req.params.id);
        if (!workspace) return apiError(404, "not_found");
        const body = CreateProjectRequest.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_project");
        const access = await repoReadToken(user.id, body.data.repo);
        if ("error" in access) return apiError(access.status, access.error, access.message);
        const file = await readProjectFile(githubApiUrl, access.token, body.data.repo);
        if ("refusal" in file) return apiError(file.refusal.status, file.refusal.error, file.refusal.message);
        const projectToken = crypto.randomUUID() + crypto.randomUUID();
        const project = projects.create(workspace.id, body.data.repo, file, projectToken);
        if (project === "exists") return apiError(409, "project_exists");
        try {
          await startComputer(project.id, projectToken);
        } catch (error) {
          projects.delete(project.id);
          await computers.destroy(project.id, { deleteData: true }).catch(() => {});
          return apiError(502, "computer_failed", String(error));
        }
        return Response.json(project satisfies Project, { status: 201 });
      },
    },
    "/projects/:id": {
      GET: member((_user, { project }) => Response.json(project satisfies Project)),
      DELETE: member(async (_user, { project, owner }: { project: Project; owner: boolean }, _req: Bun.BunRequest<"/projects/:id">) => {
        if (!owner) return apiError(403, "owner_only");
        const members = projects.memberIds(project.id);
        await workers.removeProject(project.id);
        await computers.destroy(project.id, { deleteData: true });
        coordinators.get(project.id)?.close();
        await context.remove(project.id);
        return inOrder(project.id, async () => {
          await forget(projects.delete(project.id));
          onDeleted(members);
          return new Response(null, { status: 204 });
        });
      }),
    },
    // Any member saves the settings; the coordinator gets the new config at once.
    "/projects/:id/settings": {
      PUT: member(async (_user, { project }, req: Bun.BunRequest<"/projects/:id/settings">) => {
        const body = ProjectSettingsRequest.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_settings", "expected { text }");
        const settings = parseProjectFile(body.data.text);
        if ("error" in settings) return apiError(400, "invalid_settings", `Settings: ${settings.error}`);
        const saved = projects.setSettings(project.id, body.data.text);
        if (!saved) return apiError(404, "not_found");
        toCoordinator(project.id, { type: "bound", project: saved });
        return Response.json(saved satisfies Project);
      }),
    },
    // Any member picks the coordinator's model, among those their own plan offers.
    "/projects/:id/model": {
      PUT: member(async (user, { project }, req: Bun.BunRequest<"/projects/:id/model">) => {
        const body = SetBotModelRequest.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "model_unavailable");
        const picked = pickModel(modelOptionsOf(user), body.data, project.effort);
        if ("error" in picked) return apiError(400, picked.error);
        const saved = projects.setModel(project.id, picked.model, picked.effort);
        return saved ? Response.json(saved satisfies Project) : apiError(404, "not_found");
      }),
    },
    "/projects/:id/secrets": {
      GET: member((_user, { project }, _req: Bun.BunRequest<"/projects/:id/secrets">) => Response.json(secretsOf(project) satisfies ProjectSecret[])),
    },
    // The value goes to the SecretStore only, and never comes back. It is
    // written under a new name, recorded as a leftover first; then the secret
    // points at it, and the value it replaced goes. A failed write leaves the
    // secret as it was, and its leftover goes.
    "/projects/:id/secrets/:name": {
      PUT: member(async (_user, { project }, req: Bun.BunRequest<"/projects/:id/secrets/:name">) => {
        const { name } = req.params;
        const body = SetProjectSecretRequest.safeParse(await req.json().catch(() => null));
        return inOrder(project.id, async () => {
          // The project as it is now: it may have gone, or its config changed, meanwhile.
          const current = projects.project(project.id);
          if (!current) return apiError(404, "not_found");
          if (!current.config.secrets.includes(name)) return apiError(400, "invalid_secret", `${current.name}'s config declares no secret ${name}.`);
          if (!body.success) return apiError(400, "invalid_secret", "expected { value } of 1 to 16384 characters");
          const secretName = newSecretName(current.id);
          projects.stageSecret(secretName);
          try {
            await secrets.put(secretName, body.data.value);
          } catch (error) {
            console.error(`could not save the secret ${name} of ${current.id}: ${secretFailure(error)}`);
            await forget([secretName]);
            return apiError(503, "secrets_unavailable", "Couldn't save the secret, so it keeps its last value. Try again.");
          }
          await forget(projects.publishSecret(current.id, name, secretName));
          return new Response(null, { status: 204 });
        });
      }),
      DELETE: member((_user, { project }, req: Bun.BunRequest<"/projects/:id/secrets/:name">) => {
        const name = SecretName.safeParse(req.params.name);
        if (!name.success) return apiError(404, "not_found");
        return inOrder(project.id, async () => {
          await forget(projects.clearSecret(project.id, name.data));
          return new Response(null, { status: 204 });
        });
      }),
    },
    "/projects/:id/tasks": {
      GET: member((_user, { project }, _req: Bun.BunRequest<"/projects/:id/tasks">) =>
        Response.json(projects.tasks(project.id) satisfies Task[]),
      ),
    },
    "/projects/:id/tasks/:number/done": {
      POST: member((user, { project }, req: Bun.BunRequest<"/projects/:id/tasks/:number/done">) => {
        const number = Number(req.params.number);
        const task = Number.isInteger(number) ? projects.markDone(project.id, number, user.login) : null;
        if (task === null) return apiError(404, "not_found");
        if (task === "closed") return apiError(409, "task_closed", `Task #${number} is already done or abandoned.`);
        publishTasks(project.id);
        taskClosed(project.id, number);
        return Response.json(task satisfies Task);
      }),
    },
    "/projects/:id/context": {
      GET: member(async (_user, { project }, _req: Bun.BunRequest<"/projects/:id/context">) =>
        Response.json((await context.list(project.id)) satisfies ContextFile[]),
      ),
    },
    "/projects/:id/context/file": {
      GET: member(async (_user, { project }, req: Bun.BunRequest<"/projects/:id/context/file">) => {
        const path = ContextPath.safeParse(new URL(req.url).searchParams.get("path"));
        if (!path.success) return apiError(400, "invalid_path");
        const content = await context.read(project.id, path.data);
        if (content === null) return apiError(404, "not_found");
        return Response.json({ path: path.data, content } satisfies ContextFileText);
      }),
    },
    "/projects/:id/context/image": {
      GET: member(async (_user, { project }, req: Bun.BunRequest<"/projects/:id/context/image">) => {
        const path = ContextImagePath.safeParse(new URL(req.url).searchParams.get("path"));
        if (!path.success) return apiError(400, "invalid_path");
        const bytes = await context.readImage(project.id, path.data);
        if (bytes === null) return apiError(404, "not_found");
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }),
    },
    // The answer is stored first, then wakes the call control holds.
    "/projects/:id/approvals/:approvalId": {
      POST: member(async (user, { project }, req: Bun.BunRequest<"/projects/:id/approvals/:approvalId">) => {
        const body = AnswerApprovalRequest.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_answer");
        const answer = projects.answerApproval(project.id, user.id, req.params.approvalId, body.data.approved);
        if (answer?.event.event.type !== "approval-answer") return apiError(409, "not_pending");
        publishChat(project.id, answer);
        approvals.answered(answer.event.event.approvalId, body.data.approved);
        return new Response(null, { status: 204 });
      }),
    },
    "/projects/:id/messages": {
      POST: member(async (user, { project }, req: Bun.BunRequest<"/projects/:id/messages">) => {
        const body = SendMessageRequest.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_message");
        const queued = projects.queueTurn(project.id, user.id, body.data.text);
        if (!queued) return apiError(409, "turn_running");
        publishChat(project.id, { userId: user.id, event: queued });
        schedule(project.id);
        return Response.json({ turnId: queued.turnId } satisfies SendMessageResponse, { status: 202 });
      }),
    },
    "/projects/:id/chat": {
      GET: member((user, { project }, req: Bun.BunRequest<"/projects/:id/chat">) => {
        const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
        if (!Number.isInteger(after) || after < 0) return apiError(400, "invalid_after");
        return upgrade(req, { kind: "project-chat", projectId: project.id, userId: user.id, after });
      }),
    },
    "/coordinator/:projectId": {
      GET: (req: Bun.BunRequest<"/coordinator/:projectId">) => {
        const projectId = ownCoordinator(req);
        return projectId instanceof Response ? projectId : upgrade(req, { kind: "coordinator", projectId });
      },
    },
    // Only the seat of the turn's member: a coordinator gets no one else's.
    "/coordinator/:projectId/github-token": {
      GET: (req: Bun.BunRequest<"/coordinator/:projectId/github-token">) => turnToken(req, "seat"),
    },
    "/coordinator/:projectId/installation-token": {
      GET: (req: Bun.BunRequest<"/coordinator/:projectId/installation-token">) => turnToken(req, "org"),
    },
    "/coordinator/:projectId/tools": {
      POST: async (req: Bun.BunRequest<"/coordinator/:projectId/tools">) => {
        const turn = heldTurn(store.turnKeys, req, coordinatorTurn(req.params.projectId));
        if (turn instanceof Response) return turn;
        const call = CoordinatorToolCall.safeParse(await req.json().catch(() => null));
        if (!call.success) {
          const issues = call.error.issues.map(({ path, message }) => (path.length > 0 ? `${path.join(".")}: ${message}` : message));
          return apiError(400, "invalid_tool_call", issues.join("; "));
        }
        const project = projects.project(turn.projectId);
        if (!project) return apiError(404, "not_found");
        return runTool(project, { userId: turn.userId, login: store.user(turn.userId).login }, call.data);
      },
    },
  };

  return {
    routes,

    // Projects whose coordinator is connected: their computers run.
    awake: () => [...coordinators.keys()].map((id) => ({ id })),

    // The values of the project's secrets that its config declares and that are
    // set, by name, for one of its engineers (taskWorkers.ts). Read in turn with
    // the secrets' writes, so a value being replaced is read whole. Throws when
    // the SecretStore fails.
    secretValues: (projectId: ProjectId) =>
      inOrder(projectId, async () => {
        const declared = projects.project(projectId)?.config.secrets ?? [];
        const refs = projects.secretRefs(projectId).filter(({ name }) => declared.includes(name));
        const values = await Promise.all(refs.map(async ({ name, secretName }) => ({ name, value: await secrets.get(secretName) })));
        return Object.fromEntries(values.flatMap(({ name, value }) => (value === null ? [] : [[name, value]])));
      }),

    // Whether the project's coordinator has a turn running or waiting.
    busy: (projectId: ProjectId) => projects.hasUnfinishedTurn(projectId),

    // The project's state dot for the member `login` (contracts projectState).
    stateOf: (projectId: ProjectId, login: string): ProjectState =>
      projectState({
        login,
        awake: greeted.has(projectId),
        busy: projects.hasUnfinishedTurn(projectId),
        tasks: projects.tasks(projectId),
        workers: store.taskWorkers.workersOf(projectId),
      }),

    // Stops the idle project's computer. Its coordinator is forgotten once the
    // computer is stopped, and a turn queued meanwhile starts it again.
    async sleep(projectId: ProjectId) {
      stopping.add(projectId);
      try {
        await computers.stop(projectId);
        coordinators.get(projectId)?.close();
        coordinators.delete(projectId);
        greeted.delete(projectId);
        onStateChange(projectId);
      } finally {
        stopping.delete(projectId);
      }
      wake(projectId);
    },

    // The member left the workspace or was removed: their chats close, their
    // queued turns go and their running one ends, which revokes its key, so the
    // next one runs. Each coordinator stops their session now.
    memberRemoved(workspaceId: WorkspaceId, userId: UserId) {
      for (const project of projects.projectsIn(workspaceId)) {
        for (const ws of [...(chatSockets.get(chatTopic(project.id, userId)) ?? [])]) ws.close(4003, "removed");
        toCoordinator(project.id, { type: "member-removed", userId });
      }
      const ended = projects.dropMember(workspaceId, userId);
      for (const { projectId, event } of ended) {
        if (event.event.type === "done") approvals.turnEnded(event.turnId);
        publishChat(projectId, { userId, event });
      }
      for (const projectId of new Set(ended.map(({ projectId }) => projectId))) schedule(projectId);
    },

    // Asks the member of the coordinator turn to approve `detail`, in that turn
    // of their chat, and resolves with their answer ("no_turn" once it ended).
    ask({ projectId, turnId }: CoordinatorTurn, kind: ApprovalKind, detail: string, signal: AbortSignal): Promise<ApprovalOutcome> {
      return approvals.ask((approvalId) => {
        const asked = projects.requestApproval(turnId, { approvalId, kind, detail });
        if (asked) publishChat(projectId, asked);
        return asked?.event ?? null;
      }, signal);
    },

    // Call after changing the project's ledger outside a coordinator tool call:
    // members see it, and the handoffs linked to its tasks are checked.
    ledgerChanged: publishTasks,

    // Call after queueing a turn in the store directly (a subscription's event,
    // a chief's handoff): the member's chat shows it, and the scheduler picks it up.
    queued(projectId: ProjectId, userId: UserId, event: ChatEvent) {
      publishChat(projectId, { userId, event });
      schedule(projectId);
    },

    open(ws: Socket, data: ProjectSocketData) {
      if (data.kind === "project-chat") {
        const topic = chatTopic(data.projectId, data.userId);
        chatSockets.set(topic, (chatSockets.get(topic) ?? new Set()).add(ws));
        // Subscribe first: nothing can be published between these two lines.
        ws.subscribe(topic);
        for (const event of projects.chatAfter(data.projectId, data.userId, data.after)) ws.send(JSON.stringify(event));
        return;
      }
      const project = projects.project(data.projectId);
      if (!project || stopping.has(data.projectId)) return ws.close();
      // One connection per project: a reconnecting coordinator replaces its stale socket.
      coordinators.get(data.projectId)?.close(4000, "replaced");
      coordinators.set(data.projectId, ws);
      greeted.delete(data.projectId);
      toCoordinator(data.projectId, { type: "bound", project });
    },

    close(ws: Socket, data: ProjectSocketData) {
      if (data.kind === "project-chat") {
        const topic = chatTopic(data.projectId, data.userId);
        chatSockets.get(topic)?.delete(ws);
        if (chatSockets.get(topic)?.size === 0) chatSockets.delete(topic);
        return;
      }
      if (coordinators.get(data.projectId) !== ws) return;
      coordinators.delete(data.projectId);
      greeted.delete(data.projectId);
      onStateChange(data.projectId);
    },

    message(data: ProjectSocketData, raw: string | Buffer) {
      if (data.kind !== "coordinator") return;
      const { projectId } = data;
      const message = CoordinatorToControl.parse(JSON.parse(String(raw)));
      if (message.type === "turn-event") {
        const stored = projects.appendTurnEvent(projectId, message.turnId, message.index, message.event);
        if (!stored) return;
        onActivity(projectId);
        publishChat(projectId, stored);
        if (message.event.type === "done") {
          approvals.turnEnded(message.turnId);
          schedule(projectId);
        }
        return;
      }
      // The plan's models, as a turn's session listed them, while the turn runs:
      // the plan of who pays for that turn, as recorded when it started (not as the
      // workspace bills now). The member's on their own seat (the project's model
      // picker offers them), the organization's on its billing. Turns pick their
      // model by them (turnModel). A turn with no recorded payer reports nothing.
      if (message.type === "models") {
        const payer = projects.runningTurnPayer(projectId, message.turnId);
        if (payer?.kind === "org") store.setOrgModelReport(payer.account, message.report);
        else if (payer) store.setModelReport(payer.userId, message.report);
        return;
      }
      // The coordinator lost the running turn unless it says it still runs it.
      for (const lost of projects.abandonRunningTurn(projectId, message.activeTurnId, "The coordinator restarted before it finished this message.")) {
        approvals.turnEnded(lost.event.turnId);
        publishChat(projectId, lost);
      }
      // A turn it still runs whose key control restarted without gets a new one.
      const turnId = message.activeTurnId;
      const userId = turnId && projects.runningTurnMember(projectId, turnId);
      if (turnId && userId && store.turnKeys.missing(turnId)) {
        toCoordinator(projectId, { type: "turn-key", turnId, turnKey: store.turnKeys.issue({ agent: "coordinator", projectId, userId, turnId }) });
      }
      greeted.add(projectId);
      schedule(projectId);
    },
  };
}
