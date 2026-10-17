import {
  CoordinatorToControl,
  CoordinatorToolCall,
  CreateProjectRequest,
  SendMessageRequest,
  type ChatEvent,
  type ClientEvent,
  type ContextFile,
  type ControlToCoordinator,
  type Project,
  type ProjectId,
  type SendMessageResponse,
  type Task,
  type User,
  type UserId,
} from "@chiefbot/contracts";
import type { ComputerProvider } from "./computers/computer.ts";
import type { ContextStore } from "./contextStore.ts";
import { apiError, bearer, unauthorized } from "./http.ts";
import { readProjectFile } from "./projectFile.ts";
import type { repoAccess } from "./repos.ts";
import type { openStore } from "./store.ts";
import type { tokenBroker } from "./tokens.ts";

// What a project WebSocket is bound to: a project's coordinator, or one
// member's chat with it from `after` on.
export type ProjectSocketData =
  | { kind: "coordinator"; projectId: ProjectId }
  | { kind: "project-chat"; projectId: ProjectId; userId: UserId; after: number };

// The slice of a Bun ServerWebSocket this module uses.
type Socket = { send(message: string): unknown; close(code?: number, reason?: string): void; subscribe(topic: string): void };

export type ProjectHostOptions = {
  store: ReturnType<typeof openStore>;
  broker: ReturnType<typeof tokenBroker>;
  computers: ComputerProvider;
  context: ContextStore;
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
};

// Projects: a workspace's repos, each with a coordinator on its own computer
// (from the ComputerProvider), a task ledger and shared context in control,
// and one chat with the coordinator per member. The project's scheduler runs
// one coordinator turn at a time across all members' chats, oldest first, so
// each turn sees every task the turns before it made.
//
// Member routes (a session; 404 to anyone outside the project's workspace):
//   GET    /workspaces/:id/projects  → Project[]
//   POST   /workspaces/:id/projects  body CreateProjectRequest → 201 Project. Control reads the repo's
//                                    chiefbot.project.yaml through the repo app, if the user may read it (400
//                                    invalid_project_file says what is wrong; 409 project_exists;
//                                    403 reauth_needed), then starts the coordinator's computer.
//   GET    /projects/:id             → Project
//   DELETE /projects/:id             → 204 (workspace owner only): its computer, ledger, chats and context go
//   GET    /projects/:id/tasks       → Task[]: the ledger. Every change also reaches each member's /events
//                                    as a `tasks` ClientEvent.
//   POST   /projects/:id/messages    body SendMessageRequest → 202 SendMessageResponse: queued for the
//                                    coordinator (409 turn_running while the member's last one is unfinished)
//   WS     /projects/:id/chat        ?after=<seq> → each ChatEvent of the member's own chat after seq, then live ones
// Coordinator routes (bearer: the project's credential; 403 for another project's):
//   WS     /coordinator/:projectId   ControlToCoordinator; CoordinatorToControl back
//   GET    /coordinator/:projectId/github-token/:userId  → BrokeredGitHubToken of the member whose turn
//                                    is running (404 for anyone else; 403 reauth_needed)
//   POST   /coordinator/:projectId/tools  body CoordinatorToolCall → its answer (see projects.ts in contracts)
export function projectHost({
  store,
  broker,
  computers,
  context,
  githubApiUrl,
  repoReadToken,
  controlUrlForComputers,
  publish,
  publishToUser,
  upgrade,
}: ProjectHostOptions) {
  const { projects } = store;
  // Each project's connected coordinator, and the projects whose coordinator has said hello.
  const coordinators = new Map<ProjectId, Socket>();
  const greeted = new Set<ProjectId>();

  const chatTopic = (projectId: ProjectId, userId: UserId) => `project-chat:${projectId}:${userId}`;
  const publishChat = (projectId: ProjectId, { userId, event }: { userId: UserId; event: ChatEvent }) =>
    publish(chatTopic(projectId, userId), JSON.stringify(event satisfies ChatEvent));
  const publishTasks = (projectId: ProjectId) => {
    const tasks = projects.tasks(projectId);
    for (const userId of projects.memberIds(projectId)) publishToUser(userId, { type: "tasks", projectId, tasks });
  };
  const toCoordinator = (projectId: ProjectId, message: ControlToCoordinator) =>
    coordinators.get(projectId)?.send(JSON.stringify(message));

  // The project's scheduler: once its coordinator is ready, hands it the oldest
  // queued turn, unless a turn is running (the store's claim refuses then).
  const schedule = (projectId: ProjectId) => {
    if (!greeted.has(projectId)) return;
    const next = projects.claimNextTurn(projectId);
    if (next) toCoordinator(projectId, { type: "run-turn", ...next });
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
  async function runTool(projectId: ProjectId, asker: string, call: CoordinatorToolCall): Promise<Response> {
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
        const task = projects.createTask(projectId, { ...call, owner: owner.login ?? null }, asker);
        publishTasks(projectId);
        return Response.json(task satisfies Task);
      }
      case "update_task": {
        const owner = ownerLogin(call.owner);
        if (!owner) return notMember(String(call.owner));
        const task = projects.updateTask(projectId, { ...call, owner: owner.login });
        if (!task) return apiError(404, "not_found", `No task #${call.number} in this project`);
        publishTasks(projectId);
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
    }
  }

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
        if ("error" in access) {
          return access.error === "reauth_needed" ? apiError(403, "reauth_needed") : apiError(400, "invalid_project_file", access.message);
        }
        const file = await readProjectFile(githubApiUrl, access.token, body.data.repo);
        if ("error" in file) return apiError(400, "invalid_project_file", file.error);
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
        await computers.destroy(project.id, { deleteData: true });
        coordinators.get(project.id)?.close();
        await context.remove(project.id);
        projects.delete(project.id);
        return new Response(null, { status: 204 });
      }),
    },
    "/projects/:id/tasks": {
      GET: member((_user, { project }, _req: Bun.BunRequest<"/projects/:id/tasks">) =>
        Response.json(projects.tasks(project.id) satisfies Task[]),
      ),
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
    // Only the member whose turn is running: a coordinator gets no one else's seat.
    "/coordinator/:projectId/github-token/:userId": {
      GET: async (req: Bun.BunRequest<"/coordinator/:projectId/github-token/:userId">) => {
        const projectId = ownCoordinator(req);
        if (projectId instanceof Response) return projectId;
        const asker = projects.runningMember(projectId);
        if (asker === null || asker !== req.params.userId) return apiError(404, "not_found");
        const token = await broker.accessToken(asker);
        return token ? Response.json(token) : apiError(403, "reauth_needed");
      },
    },
    "/coordinator/:projectId/tools": {
      POST: async (req: Bun.BunRequest<"/coordinator/:projectId/tools">) => {
        const projectId = ownCoordinator(req);
        if (projectId instanceof Response) return projectId;
        const call = CoordinatorToolCall.safeParse(await req.json().catch(() => null));
        if (!call.success) {
          const issues = call.error.issues.map(({ path, message }) => (path.length > 0 ? `${path.join(".")}: ${message}` : message));
          return apiError(400, "invalid_tool_call", issues.join("; "));
        }
        const asker = projects.runningMember(projectId);
        if (!asker) return apiError(409, "invalid_tool_call", "No coordinator turn is running");
        return runTool(projectId, store.user(asker).login, call.data);
      },
    },
  };

  return {
    routes,

    open(ws: Socket, data: ProjectSocketData) {
      if (data.kind === "project-chat") {
        // Subscribe first: nothing can be published between these two lines.
        ws.subscribe(chatTopic(data.projectId, data.userId));
        for (const event of projects.chatAfter(data.projectId, data.userId, data.after)) ws.send(JSON.stringify(event));
        return;
      }
      const project = projects.project(data.projectId);
      if (!project) return ws.close();
      // One connection per project: a reconnecting coordinator replaces its stale socket.
      coordinators.get(data.projectId)?.close(4000, "replaced");
      coordinators.set(data.projectId, ws);
      greeted.delete(data.projectId);
      toCoordinator(data.projectId, { type: "bound", project });
    },

    close(ws: Socket, data: ProjectSocketData) {
      if (data.kind !== "coordinator" || coordinators.get(data.projectId) !== ws) return;
      coordinators.delete(data.projectId);
      greeted.delete(data.projectId);
    },

    message(data: ProjectSocketData, raw: string | Buffer) {
      if (data.kind !== "coordinator") return;
      const { projectId } = data;
      const message = CoordinatorToControl.parse(JSON.parse(String(raw)));
      if (message.type === "turn-event") {
        const stored = projects.appendTurnEvent(projectId, message.turnId, message.index, message.event);
        if (!stored) return;
        publishChat(projectId, stored);
        if (message.event.type === "done") schedule(projectId);
        return;
      }
      // The coordinator lost the running turn unless it says it still runs it.
      for (const lost of projects.abandonRunningTurn(projectId, message.activeTurnId, "The coordinator restarted before it finished this message.")) {
        publishChat(projectId, lost);
      }
      greeted.add(projectId);
      schedule(projectId);
    },
  };
}
