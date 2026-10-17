import type { PermissionRequest } from "@github/copilot-sdk";
import type { ApprovalKind } from "@chiefbot/contracts";

// What the user must approve, in the bot's computer, before the Copilot runtime
// may do `request`, or null when it runs without asking. Pushes and pull
// requests are not asked here: control holds repo access and asks for each one
// itself (apps/control/src/repos.ts). Everything else in the bot's own computer
// (reading, editing, commands) runs freely: the computer is the bot's sandbox.
// What remains is a GitHub MCP tool that writes: it runs on the owner's sign-in
// token inside the computer, so this asks first (a guardrail, docs/isolation.md).
export function approvalFor(request: PermissionRequest): { kind: ApprovalKind; detail: string } | null {
  if (request.kind === "mcp" && !request.readOnly) return { kind: "tool", detail: `${request.serverName}: ${request.toolTitle}` };
  return null;
}
