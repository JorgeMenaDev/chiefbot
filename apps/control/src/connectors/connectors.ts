import {
  ConnectorInput,
  ConnectorTokenRequest,
  ReportedConnectorCall,
  type AgentConnector,
  type CallIdentity,
  type ChecklistItem,
  type ConnectStart,
  type Connector,
  type ConnectorCall,
  type ProjectId,
  type User,
  type UserId,
  type Workspace,
  type WorkspaceId,
} from "@chiefbot/contracts";
import { z } from "zod";
import { apiError, bearer, unauthorized } from "../http.ts";
import type { SecretStore } from "../secrets/secretStore.ts";
import { openMcpSession } from "./mcpClient.ts";
import { finishSignIn, PersonalCredential, refreshed, startSignIn, type PendingSignIn } from "./mcpOAuth.ts";
import type { openStore } from "../store.ts";

export type ConnectorHostOptions = {
  store: ReturnType<typeof openStore>;
  secrets: SecretStore;
  // Control's URL as the member's browser reaches it: OAuth sign-ins come back to its callback.
  publicUrl: () => string;
};


// SecretStore names: the workspace's credential, and each member's own.
const workspaceSecretName = (workspaceId: WorkspaceId, name: string) => `connector-${workspaceId}-${name}`;
const personalSecretName = (workspaceId: WorkspaceId, name: string, userId: UserId) => `connector-${workspaceId}-${name}-${userId}`;

// Connectors: MCP servers a workspace defines once, which its projects' agents
// reach as the workspace's credential or as the member whose turn calls them.
//
// Member routes (a session; 404 to anyone outside the workspace):
//   GET    /workspaces/:id/connectors              → Connector[] (never a secret)
//   POST   /workspaces/:id/connectors              body ConnectorInput → 201 Connector (owner only;
//                                                  409 connector_exists)
//   DELETE /workspaces/:id/connectors/:name        → 204 (owner only); its secrets go too
//   PUT    /workspaces/:id/connectors/:name/secret body ConnectorTokenRequest → 204: the workspace
//                                                  credential of a workspace-secret connector (owner only)
//   PUT    /workspaces/:id/connectors/:name/token  body ConnectorTokenRequest → 204: the member's own
//                                                  token for a personal-oauth connector
//   POST   /workspaces/:id/connectors/:name/connect → ConnectStart, the member's connect action for a
//                                                  personal-oauth connector: the MCP server's OAuth sign-in
//                                                  when it offers one control can run, otherwise "token"
//   GET    /connectors/oauth/callback?code&state   (no session: `state` is the capability) where the sign-in
//                                                  returns; stores the member's credential, answers a page
//   GET    /workspaces/:id/checklist               → ChecklistItem[]: each connector the workspace's
//                                                  projects declare, and what it still needs for the member
//   GET    /projects/:id/connector-calls           → ConnectorCall[]: the project's call log, oldest first
// Coordinator routes (bearer: the project's credential; 403 for another project's):
//   GET|POST|DELETE /coordinator/:projectId/mcp/:name  control's proxy to a remote connector the project
//                    declares (404 for any other), Streamable HTTP. Header x-chiefbot-member names the
//                    member whose session it is. Control adds that call's identity (403
//                    connector_not_ready without one) and logs each tools/call, which must come during
//                    that member's turn (409 no_turn otherwise).
//   POST   /coordinator/:projectId/connector-calls  body ReportedConnectorCall → 204: a command
//                    connector's call, logged for the running turn (409 no_turn without one)
export function connectorHost({ store, secrets, publicUrl }: ConnectorHostOptions) {
  const { connectors, workspaces, projects } = store;
  // Sign-ins waiting for their callback, by state, for ten minutes. In memory:
  // a control restart means the member clicks Connect again.
  const signIns = new Map<string, { pending: PendingSignIn; workspaceId: WorkspaceId; name: string; title: string; userId: UserId; until: number }>();

  // Runs a /workspaces/:id route for a signed-in member of :id; 401 or 404 otherwise.
  const member =
    <Req extends Request & { params: { id: string } }>(
      handle: (user: User, workspace: Workspace, req: Req) => Response | Promise<Response>,
    ) =>
    (req: Req) => {
      const user = store.userForSession(bearer(req));
      if (!user) return unauthorized();
      const workspace = workspaces.workspaceFor(user.id, req.params.id);
      if (!workspace) return apiError(404, "not_found");
      return handle(user, workspace, req);
    };

  // The connector :name of the workspace, or a 404.
  const found = (workspace: Workspace, name: string) => connectors.get(workspace.id, name) ?? apiError(404, "not_found");

  const tokenBody = async (req: Request) => ConnectorTokenRequest.safeParse(await req.json().catch(() => null)).data?.token ?? null;

  // Whether a connector's calls can run for the member now.
  const ready = (connector: Connector, linked: Set<string>) =>
    connector.auth === "none" || (connector.auth === "workspace-secret" ? connector.hasWorkspaceSecret : linked.has(connector.name));

  function checklist(workspaceId: WorkspaceId, userId: UserId): ChecklistItem[] {
    const linked = connectors.linkedNames(workspaceId, userId);
    const needed = new Map<string, string[]>();
    for (const project of projects.projectsIn(workspaceId)) {
      for (const name of project.file.connectors) needed.set(name, [...(needed.get(name) ?? []), project.name]);
    }
    return [...needed].map(([name, projectNames]) => {
      const connector = connectors.get(workspaceId, name);
      if (!connector) return { name, title: null, auth: null, projects: projectNames, status: "not-defined" };
      const status = ready(connector, linked) ? "ready" : connector.auth === "workspace-secret" ? "workspace-secret" : "connect";
      return { name, title: connector.title, auth: connector.auth, projects: projectNames, status };
    });
  }

  // The identity a connector's call runs as for the member, with its token; null
  // when there is none yet. An OAuth sign-in about to expire is refreshed first.
  async function credentialFor(connector: Connector, userId: UserId): Promise<{ identity: CallIdentity; token: string | null } | null> {
    if (connector.auth === "none") return { identity: "none", token: null };
    if (connector.auth === "workspace-secret") {
      const token = await secrets.get(workspaceSecretName(connector.workspaceId, connector.name));
      return token === null ? null : { identity: "workspace", token };
    }
    const name = personalSecretName(connector.workspaceId, connector.name, userId);
    const stored = PersonalCredential.safeParse(JSON.parse((await secrets.get(name)) ?? "null"));
    if (!stored.success) return null;
    const credential = await refreshed(stored.data);
    if (!credential) return null;
    if (credential !== stored.data) await secrets.put(name, JSON.stringify(credential));
    return { identity: "personal", token: credential.accessToken };
  }

  // The connectors a member's agent session gets in a project: those its project
  // file declares that the workspace defines and that are ready for the member.
  async function agentConnectors(projectId: ProjectId, userId: UserId): Promise<AgentConnector[]> {
    const project = projects.project(projectId);
    if (!project) return [];
    const linked = connectors.linkedNames(project.workspaceId, userId);
    const result: AgentConnector[] = [];
    for (const name of new Set(project.file.connectors)) {
      const connector = connectors.get(project.workspaceId, name);
      if (!connector || !ready(connector, linked)) continue;
      const { server } = connector;
      if (server.kind === "remote") {
        result.push({ kind: "remote", name: connector.name });
        continue;
      }
      const credential = await credentialFor(connector, userId);
      if (!credential) continue;
      const token = server.tokenEnv && credential.token !== null ? { [server.tokenEnv]: credential.token } : {};
      result.push({ kind: "command", name: connector.name, command: server.command, args: server.args, env: { ...server.env, ...token } });
    }
    return result;
  }

  // The project whose credential the request carries, if it is :projectId's; 401 or 403 otherwise.
  const ownCoordinator = (req: Request & { params: { projectId: string } }) => {
    const projectId = projects.projectForToken(bearer(req));
    if (!projectId) return unauthorized();
    if (projectId !== req.params.projectId) return apiError(403, "wrong_bot");
    return projectId;
  };

  // A connector the project declares and its workspace defines; null for any other.
  const declared = (projectId: ProjectId, name: string) => {
    const project = projects.project(projectId);
    return project?.file.connectors.includes(name) ? connectors.get(project.workspaceId, name) : null;
  };

  // The proxy to a remote connector (see the route list above).
  async function proxy(req: Request & { params: { projectId: string; name: string } }, server: Bun.Server<unknown>) {
    const projectId = ownCoordinator(req);
    if (projectId instanceof Response) return projectId;
    const connector = declared(projectId, req.params.name);
    if (connector?.server.kind !== "remote") return apiError(404, "not_found");
    const asker = projects.member(projectId, { userId: req.headers.get("x-chiefbot-member") ?? "" });
    if (!asker) return apiError(404, "not_found", "x-chiefbot-member is not a member of this project's workspace");
    const body = req.method === "POST" ? await req.text() : null;
    const tools = body === null ? [] : toolCallsIn(body);
    const running = projects.runningTurn(projectId);
    if (tools.length > 0 && running?.userId !== asker.userId) {
      return apiError(409, "no_turn", `A ${connector.name} call can only run during ${asker.login}'s turn`);
    }
    const credential = await credentialFor(connector, asker.userId);
    if (!credential) return apiError(403, "connector_not_ready", `${asker.login} has no ${connector.name} credential: see the checklist`);
    for (const tool of tools) {
      connectors.logCall(projectId, { connector: connector.name, tool, requester: asker.login, identity: credential.identity, run: running?.turnId ?? "" });
    }
    const headers = pick(req.headers, ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]);
    if (credential.token !== null) headers.set("authorization", `Bearer ${credential.token}`);
    // A GET is the server's event stream: it stays open.
    server.timeout(req, 0);
    const upstream = await fetch(connector.server.url, { method: req.method, headers, body, signal: req.signal });
    if (upstream.status === 401) {
      return apiError(403, "connector_not_ready", `${connector.name} refused ${asker.login}'s credential: connect again`);
    }
    return new Response(upstream.body, { status: upstream.status, headers: pick(upstream.headers, ["content-type", "mcp-session-id"]) });
  }

  // Control's own MCP session with a remote connector the project declares, for
  // subscription polls: as the workspace's credential, or as `userId` for a
  // personal connector. Each tool call is logged with `userId` as the requester
  // and `run` (the subscription) as the run. Throws with why it cannot connect.
  async function controlSession(projectId: ProjectId, name: string, userId: UserId, run: string) {
    const connector = declared(projectId, name);
    if (connector?.server.kind !== "remote") throw new Error(`The project declares no remote connector ${name}.`);
    const credential = await credentialFor(connector, userId);
    const login = store.user(userId).login;
    if (!credential) throw new Error(`${name} has no credential for ${login} yet: see the checklist.`);
    const session = await openMcpSession(connector.server.url, credential.token);
    return {
      identity: credential.identity,
      listTools: session.listTools,
      callTool(tool: string, args: Record<string, unknown>) {
        connectors.logCall(projectId, { connector: name, tool, requester: login, identity: credential.identity, run });
        return session.callTool(tool, args);
      },
    };
  }

  const routes = {
    "/coordinator/:projectId/mcp/:name": { GET: proxy, POST: proxy, DELETE: proxy },
    "/coordinator/:projectId/connector-calls": {
      POST: async (req: Bun.BunRequest<"/coordinator/:projectId/connector-calls">) => {
        const projectId = ownCoordinator(req);
        if (projectId instanceof Response) return projectId;
        const body = ReportedConnectorCall.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_connector", z.prettifyError(body.error));
        const connector = declared(projectId, body.data.connector);
        if (connector?.server.kind !== "command") return apiError(404, "not_found");
        const running = projects.runningTurn(projectId);
        if (!running) return apiError(409, "no_turn");
        const identity: CallIdentity = connector.auth === "none" ? "none" : connector.auth === "workspace-secret" ? "workspace" : "personal";
        connectors.logCall(projectId, { ...body.data, requester: store.user(running.userId).login, identity, run: running.turnId });
        return new Response(null, { status: 204 });
      },
    },
    "/projects/:id/connector-calls": {
      GET: (req: Bun.BunRequest<"/projects/:id/connector-calls">) => {
        const user = store.userForSession(bearer(req));
        if (!user) return unauthorized();
        const found = projects.projectFor(user.id, req.params.id);
        if (!found) return apiError(404, "not_found");
        return Response.json(connectors.calls(found.project.id) satisfies ConnectorCall[]);
      },
    },
    "/workspaces/:id/connectors": {
      GET: member((_user, workspace) => Response.json(connectors.list(workspace.id) satisfies Connector[])),
      POST: member(async (_user, workspace, req: Bun.BunRequest<"/workspaces/:id/connectors">) => {
        if (workspace.role !== "owner") return apiError(403, "owner_only");
        const body = ConnectorInput.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_connector", z.prettifyError(body.error));
        const created = connectors.create(workspace.id, body.data);
        if (created === "exists") return apiError(409, "connector_exists");
        return Response.json(created satisfies Connector, { status: 201 });
      }),
    },
    "/workspaces/:id/connectors/:name": {
      DELETE: member(async (_user, workspace, req: Bun.BunRequest<"/workspaces/:id/connectors/:name">) => {
        if (workspace.role !== "owner") return apiError(403, "owner_only");
        const connector = found(workspace, req.params.name);
        if (connector instanceof Response) return connector;
        const linked = connectors.delete(workspace.id, connector.name);
        await secrets.delete(workspaceSecretName(workspace.id, connector.name));
        for (const userId of linked) await secrets.delete(personalSecretName(workspace.id, connector.name, userId));
        return new Response(null, { status: 204 });
      }),
    },
    "/workspaces/:id/connectors/:name/secret": {
      PUT: member(async (_user, workspace, req: Bun.BunRequest<"/workspaces/:id/connectors/:name/secret">) => {
        if (workspace.role !== "owner") return apiError(403, "owner_only");
        const connector = found(workspace, req.params.name);
        if (connector instanceof Response) return connector;
        if (connector.auth !== "workspace-secret") return apiError(400, "invalid_connector", `${connector.name} takes no workspace secret`);
        const token = await tokenBody(req);
        if (token === null) return apiError(400, "invalid_connector", "expected { token }");
        await secrets.put(workspaceSecretName(workspace.id, connector.name), token);
        connectors.setHasSecret(workspace.id, connector.name, true);
        return new Response(null, { status: 204 });
      }),
    },
    "/workspaces/:id/connectors/:name/token": {
      PUT: member(async (user, workspace, req: Bun.BunRequest<"/workspaces/:id/connectors/:name/token">) => {
        const connector = found(workspace, req.params.name);
        if (connector instanceof Response) return connector;
        if (connector.auth !== "personal-oauth") return apiError(400, "invalid_connector", `${connector.name} takes no personal token`);
        const token = await tokenBody(req);
        if (token === null) return apiError(400, "invalid_connector", "expected { token }");
        await savePersonal(workspace.id, connector.name, user.id, { accessToken: token }, "token");
        return new Response(null, { status: 204 });
      }),
    },
    "/workspaces/:id/connectors/:name/connect": {
      POST: member(async (user, workspace, req: Bun.BunRequest<"/workspaces/:id/connectors/:name/connect">) => {
        const connector = found(workspace, req.params.name);
        if (connector instanceof Response) return connector;
        if (connector.auth !== "personal-oauth") return apiError(400, "invalid_connector", `${connector.name} needs no personal connection`);
        const state = crypto.randomUUID();
        const started =
          connector.server.kind === "remote"
            ? await startSignIn({ serverUrl: connector.server.url, scope: connector.scope, redirectUri: `${publicUrl()}/connectors/oauth/callback`, state })
            : null;
        if (!started) return Response.json({ kind: "token" } satisfies ConnectStart);
        for (const [key, { until }] of signIns) if (until < Date.now()) signIns.delete(key);
        signIns.set(state, { pending: started.pending, workspaceId: workspace.id, name: connector.name, title: connector.title, userId: user.id, until: Date.now() + 600_000 });
        return Response.json({ kind: "oauth", authorizeUrl: started.authorizeUrl } satisfies ConnectStart);
      }),
    },
    "/connectors/oauth/callback": {
      GET: async (req: Request) => {
        const params = new URL(req.url).searchParams;
        const state = params.get("state") ?? "";
        const signIn = signIns.get(state);
        signIns.delete(state);
        const code = params.get("code");
        const credential = signIn && signIn.until >= Date.now() && code ? await finishSignIn(signIn.pending, code) : null;
        if (!signIn || !credential) return page(400, "This sign-in did not work or has expired. Click Connect in Chiefbot again.");
        await savePersonal(signIn.workspaceId, signIn.name, signIn.userId, credential, "oauth");
        return page(200, `Connected to ${signIn.title}. You can close this tab and go back to Chiefbot.`);
      },
    },
    "/workspaces/:id/checklist": {
      GET: member((user, workspace) => Response.json(checklist(workspace.id, user.id) satisfies ChecklistItem[])),
    },
  };

  async function savePersonal(workspaceId: WorkspaceId, name: string, userId: UserId, credential: PersonalCredential, via: "oauth" | "token") {
    await secrets.put(personalSecretName(workspaceId, name, userId), JSON.stringify(credential));
    connectors.link(workspaceId, name, userId, via);
  }

  return { routes, agentConnectors, controlSession };
}

// The tools a JSON-RPC message (or batch) calls: each tools/call's tool name.
const RpcMessage = z.object({ method: z.string().optional(), params: z.object({ name: z.unknown() }).partial().optional() });
function toolCallsIn(body: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const messages = RpcMessage.array().safeParse(Array.isArray(json) ? json : [json]).data ?? [];
  return messages.flatMap(({ method, params }) => (method === "tools/call" ? [String(params?.name ?? "")] : []));
}

// The small HTML page a member's browser shows at the end of a sign-in.
const page = (status: number, text: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Chiefbot</title><p>${Bun.escapeHTML(text)}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

// A copy of only the `names` headers that are set.
function pick(headers: Headers, names: string[]) {
  const picked = new Headers();
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) picked.set(name, value);
  }
  return picked;
}
