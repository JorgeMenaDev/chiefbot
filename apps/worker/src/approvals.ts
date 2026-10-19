import type { PermissionRequest } from "@github/copilot-sdk";
import type { AgentConnection, ApprovalKind } from "@chiefbot/contracts";
import { connectionWrites } from "./connections.ts";

// What the user must approve, in the bot's computer, before the Copilot runtime
// may do `request`, or null when it runs without asking. Pushes and pull
// requests are not asked here: control holds repo access and asks for each one
// itself (apps/control/src/repos.ts). Everything else in the bot's own computer
// (reading, editing, commands) runs freely: the computer is the bot's sandbox.
// What remains runs with the owner's own credentials inside the computer, so
// this asks first (a guardrail, docs/isolation.md): a GitHub MCP tool that
// writes, on the owner's sign-in token, and a command of one of the turn's
// `connections`' CLIs that matches none of its read-only globs (connections.ts).
export function approvalFor(request: PermissionRequest, connections: AgentConnection[] = []): { kind: ApprovalKind; detail: string } | null {
  if (request.kind === "mcp" && !request.readOnly) return { kind: "tool", detail: `${request.serverName}: ${request.toolTitle}` };
  const writes = connectionWrites(request, connections);
  if (writes.length > 0) return { kind: "connector", detail: writes.map(({ connection, command }) => `${connection.title}: ${command}`).join("; ") };
  return null;
}
