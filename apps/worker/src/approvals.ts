import type { PermissionRequest } from "@github/copilot-sdk";
import { DEFAULT_ACCESS, type AccessMode, type AgentConnection, type ApprovalKind } from "@chiefbot/contracts";
import { connectionWrites } from "./connections.ts";

// What the user must approve, in the bot's computer, before the Copilot runtime
// may do `request`, or null when it runs without asking. Pushes and pull
// requests are not asked here: control holds repo access and asks for each one
// itself (apps/control/src/repos.ts), in every access mode.
// The bot's `access` mode (contracts AccessMode) sets what else asks:
//   auto (the default, and always for task workers): everything in the bot's own
//     computer (reading, editing, commands) runs freely: the computer is the bot's
//     sandbox. What runs with the owner's own credentials inside it asks first (a
//     guardrail, docs/isolation.md): a GitHub MCP tool that writes, on the owner's
//     sign-in token, and a command of one of the turn's `connections`' CLIs that
//     matches none of its read-only globs (connections.ts).
//   auto-accept-edits: those, and every shell command the runtime does not see
//     only reading. File changes run.
//   supervised: those, every shell command and every file change.
//   full-access: nothing asks.
// Reads, URLs, memory and the worker's own tools never ask.
export function approvalFor(
  request: PermissionRequest,
  connections: AgentConnection[] = [],
  access: AccessMode = DEFAULT_ACCESS,
): { kind: ApprovalKind; detail: string } | null {
  if (access === "full-access") return null;
  if (request.kind === "mcp" && !request.readOnly) return { kind: "tool", detail: `${request.serverName}: ${request.toolTitle}` };
  const writes = connectionWrites(request, connections);
  if (writes.length > 0) return { kind: "connector", detail: writes.map(({ connection, command }) => `${connection.title}: ${command}`).join("; ") };
  if (access === "auto") return null;
  if (request.kind === "write" && access === "supervised") return { kind: "file-change", detail: request.fileName };
  if (request.kind === "shell" && (access === "supervised" || !onlyReads(request))) return { kind: "command", detail: request.fullCommandText };
  return null;
}

// Whether the runtime parsed a shell command as only reading: every command in it
// read-only, and no redirect into a file. A command it could not parse writes.
function onlyReads(request: Extract<PermissionRequest, { kind: "shell" }>) {
  return !request.hasWriteFileRedirection && request.commands.length > 0 && request.commands.every(({ readOnly }) => readOnly);
}
