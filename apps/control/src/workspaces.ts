import {
  CreateWorkspaceRequest,
  SetCopilotModeRequest,
  InviteRequest,
  UserId,
  type User,
  type Workspace,
  type WorkspaceId,
  type WorkspaceDetail,
  type WorkspaceInvite,
} from "@chiefbot/contracts";
import { apiError, bearer, unauthorized } from "./http.ts";
import type { openStore } from "./store.ts";

// Control's workspace routes, spread into its Bun.serve routes. Each needs a
// session; a /workspaces/:id route answers 404 to anyone who is not a member,
// so a non-member cannot tell the workspace exists.
//   GET    /workspaces       → Workspace[]: the user's, with their role in each
//   POST   /workspaces       body CreateWorkspaceRequest → 201 Workspace (the user is its owner)
//   GET    /workspaces/:id   → WorkspaceDetail: members and pending invites
//   PUT    /workspaces/:id/copilot-mode  body SetCopilotModeRequest → Workspace (owner only): who pays
//                             for the Copilot requests of its projects' agents, from their next run on
//   POST   /workspaces/:id/invites  body InviteRequest → 201 WorkspaceInvite (owner only). Inviting
//                             a login again returns its pending invite; 409 already_member for a member's login.
//   DELETE /workspaces/:id/invites/:inviteId  → 204; the owner withdraws a pending invite
//   DELETE /workspaces/:id/members/:userId  → 204. A member may remove themselves (leave);
//                             only the owner removes others (403 owner_only). The owner cannot
//                             leave (409 owner_cannot_leave). `onMemberRemoved` then ends what
//                             still runs for them in the workspace's projects.
//   GET    /invites          → WorkspaceInvite[]: the pending invites for the user's GitHub login
//   POST   /invites/:inviteId/accept  → Workspace; the user is a member now (404 unless the invite is for their login)
export function workspaceRoutes(
  store: ReturnType<typeof openStore>,
  onMemberRemoved: (workspaceId: WorkspaceId, userId: UserId) => Promise<void>,
) {
  const { workspaces } = store;

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

  return {
    "/workspaces": {
      GET: (req: Request) => {
        const user = store.userForSession(bearer(req));
        return user ? Response.json(workspaces.workspacesFor(user.id)) : unauthorized();
      },
      POST: async (req: Request) => {
        const user = store.userForSession(bearer(req));
        if (!user) return unauthorized();
        const body = CreateWorkspaceRequest.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_workspace");
        return Response.json(workspaces.create(user.id, body.data.name) satisfies Workspace, { status: 201 });
      },
    },
    "/workspaces/:id": {
      GET: member((_user, workspace) =>
        Response.json({
          ...workspace,
          members: workspaces.members(workspace.id),
          invites: workspaces.invites(workspace.id),
        } satisfies WorkspaceDetail),
      ),
    },
    "/workspaces/:id/copilot-mode": {
      PUT: member(async (_user, workspace, req: Bun.BunRequest<"/workspaces/:id/copilot-mode">) => {
        if (workspace.role !== "owner") return apiError(403, "owner_only");
        const body = SetCopilotModeRequest.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_copilot_mode");
        workspaces.setCopilotMode(workspace.id, body.data.mode);
        return Response.json({ ...workspace, copilotMode: body.data.mode } satisfies Workspace);
      }),
    },
    "/workspaces/:id/invites": {
      POST: member(async (user, workspace, req) => {
        if (workspace.role !== "owner") return apiError(403, "owner_only");
        const body = InviteRequest.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_invite");
        const invite = workspaces.invite(workspace.id, body.data.login, user.id);
        if (invite === "already_member") return apiError(409, "already_member");
        return Response.json(invite satisfies WorkspaceInvite, { status: 201 });
      }),
    },
    "/workspaces/:id/invites/:inviteId": {
      DELETE: member((_user, workspace, req: Bun.BunRequest<"/workspaces/:id/invites/:inviteId">) => {
        if (workspace.role !== "owner") return apiError(403, "owner_only");
        if (!workspaces.revokeInvite(workspace.id, req.params.inviteId)) return apiError(404, "not_found");
        return new Response(null, { status: 204 });
      }),
    },
    "/workspaces/:id/members/:userId": {
      DELETE: member(async (user, workspace, req: Bun.BunRequest<"/workspaces/:id/members/:userId">) => {
        const leaving = req.params.userId === user.id;
        if (leaving && workspace.role === "owner") return apiError(409, "owner_cannot_leave");
        if (!leaving && workspace.role !== "owner") return apiError(403, "owner_only");
        if (!workspaces.removeMember(workspace.id, req.params.userId)) return apiError(404, "not_found");
        await onMemberRemoved(workspace.id, UserId.parse(req.params.userId));
        return new Response(null, { status: 204 });
      }),
    },
    "/invites": {
      GET: (req: Request) => {
        const user = store.userForSession(bearer(req));
        return user ? Response.json(workspaces.invitesForLogin(user.login)) : unauthorized();
      },
    },
    "/invites/:inviteId/accept": {
      POST: (req: Bun.BunRequest<"/invites/:inviteId/accept">) => {
        const user = store.userForSession(bearer(req));
        if (!user) return unauthorized();
        const workspace = workspaces.accept(user, req.params.inviteId);
        return workspace ? Response.json(workspace satisfies Workspace) : apiError(404, "not_found");
      },
    },
  };
}
