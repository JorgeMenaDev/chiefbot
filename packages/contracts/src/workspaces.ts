import { z } from "zod";
import { InviteId, UserId, WorkspaceId } from "./ids.ts";

// owner:  created the workspace; invites people and removes members.
// member: joined by accepting an invite; can leave.
export const WorkspaceRole = z.enum(["owner", "member"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

// A workspace as one of its members sees it. `role` is that member's role.
export const Workspace = z.object({ id: WorkspaceId, name: z.string(), role: WorkspaceRole });
export type Workspace = z.infer<typeof Workspace>;

export const WorkspaceMember = z.object({ userId: UserId, login: z.string(), role: WorkspaceRole });
export type WorkspaceMember = z.infer<typeof WorkspaceMember>;

// A GitHub login as GitHub allows it: up to 39 letters, digits and single
// hyphens, not starting or ending with one. GitHub matches logins case-insensitively.
export const GitHubLogin = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/);

// An invite waits until a user with `login` signs in to control and accepts it.
// `invitedBy` is the inviting owner's login.
export const WorkspaceInvite = z.object({
  id: InviteId,
  workspaceId: WorkspaceId,
  workspaceName: z.string(),
  login: z.string(),
  invitedBy: z.string(),
});
export type WorkspaceInvite = z.infer<typeof WorkspaceInvite>;

// Response of GET /workspaces/:id: the workspace with its members and pending invites.
export const WorkspaceDetail = Workspace.extend({
  members: z.array(WorkspaceMember),
  invites: z.array(WorkspaceInvite),
});
export type WorkspaceDetail = z.infer<typeof WorkspaceDetail>;

// Body of POST /workspaces.
export const CreateWorkspaceRequest = z.object({ name: z.string().trim().min(1).max(60) });
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

// Body of POST /workspaces/:id/invites.
export const InviteRequest = z.object({ login: GitHubLogin });
export type InviteRequest = z.infer<typeof InviteRequest>;
