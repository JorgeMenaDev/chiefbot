import {
  Workspace,
  WorkspaceDetail,
  WorkspaceInvite,
  type CopilotMode,
  type InviteId,
  type UserId,
  type WorkspaceId,
} from "@chiefbot/contracts";
import { controlCaller } from "./controlApi.ts";

export type WorkspacesOptions = {
  controlUrl: string;
  // The saved control session, or null when signed out.
  session: () => string | null;
};

// The signed-in user's workspaces (teams), owned by Electron main: plain HTTP
// calls to control, which checks membership and roles on every one.
export function createWorkspaces({ controlUrl, session }: WorkspacesOptions) {
  const call = controlCaller({ controlUrl, session });

  return {
    list: async () => Workspace.array().parse(await (await call("GET", "/workspaces")).json()),
    create: async (name: string) => Workspace.parse(await (await call("POST", "/workspaces", { name })).json()),
    // Members and pending invites.
    detail: async (workspaceId: WorkspaceId) =>
      WorkspaceDetail.parse(await (await call("GET", `/workspaces/${workspaceId}`)).json()),
    // The owner only: who pays for the Copilot of the workspace's project agents.
    setCopilotMode: async (workspaceId: WorkspaceId, mode: CopilotMode) =>
      Workspace.parse(await (await call("PUT", `/workspaces/${workspaceId}/copilot-mode`, { mode })).json()),
    invite: async (workspaceId: WorkspaceId, login: string) =>
      WorkspaceInvite.parse(await (await call("POST", `/workspaces/${workspaceId}/invites`, { login })).json()),
    revokeInvite: async (workspaceId: WorkspaceId, inviteId: InviteId) =>
      void (await call("DELETE", `/workspaces/${workspaceId}/invites/${inviteId}`)),
    // The owner removes a member; with their own id, a member leaves.
    removeMember: async (workspaceId: WorkspaceId, userId: UserId) =>
      void (await call("DELETE", `/workspaces/${workspaceId}/members/${userId}`)),

    // Invites waiting for the user's GitHub login.
    invites: async () => WorkspaceInvite.array().parse(await (await call("GET", "/invites")).json()),
    accept: async (inviteId: InviteId) => Workspace.parse(await (await call("POST", `/invites/${inviteId}/accept`)).json()),
  };
}
