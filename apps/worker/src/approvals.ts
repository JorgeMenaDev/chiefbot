import type { PermissionRequest } from "@github/copilot-sdk";
import { DEFAULT_ACCESS, type AccessMode, type AgentConnection, type ApprovalKind, type ChiefToolCall } from "@chiefbot/contracts";
import { connectionWrites } from "./connections.ts";
import { pullRequestToolName } from "./pullRequest.ts";

type Ask = { kind: ApprovalKind; detail: string };

// What the user must approve, in the bot's computer, before the Copilot runtime
// may do `request`, or null when it runs without asking. Pushes and pull
// requests are not asked here: control holds repo access and asks for each one
// itself (apps/control/src/repos.ts), in every access mode.
// The bot's `access` mode (contracts AccessMode) sets what else asks:
//   auto (the default, and always for task workers): everything in the bot's own
//     computer runs freely: the computer is the bot's sandbox. What runs with the
//     owner's own credentials inside it asks first (a guardrail, docs/isolation.md):
//     a GitHub MCP tool that writes, on the owner's sign-in token, and a command of
//     one of the turn's `connections`' CLIs that matches none of its read-only globs
//     (connections.ts).
//   auto-accept-edits: those, and every change but a file change (askedWhenRestricted).
//   supervised: those, and every change.
//   full-access: nothing asks.
export function approvalFor(request: PermissionRequest, connections: AgentConnection[] = [], access: AccessMode = DEFAULT_ACCESS): Ask | null {
  if (access === "full-access") return null;
  if (request.kind === "mcp" && !request.readOnly) return { kind: "tool", detail: `${request.serverName}: ${request.toolTitle}` };
  const writes = connectionWrites(request, connections);
  if (writes.length > 0) return { kind: "connector", detail: writes.map(({ connection, command }) => `${connection.title}: ${command}`).join("; ") };
  if (access === "auto") return null;
  return askedWhenRestricted(request, access === "supervised");
}

// The worker's own tools that run unasked: create_pull_request, as control asks
// for each pull request itself, and the chief tools that only read.
const runsUnasked: ReadonlySet<string> = new Set<ChiefToolCall["tool"] | typeof pullRequestToolName>([
  pullRequestToolName,
  "list_projects",
  "handoff_status",
]);

// What supervised (and, but for file changes, auto-accept-edits) asks, by every
// kind the runtime may request: reads run, anything that changes something asks.
// A shell command the runtime sees only reading runs under auto-accept-edits.
function askedWhenRestricted(request: PermissionRequest, supervised: boolean): Ask | null {
  switch (request.kind) {
    case "read":
    case "url":
    case "mcp":
      return null;
    case "write":
      return supervised ? { kind: "file-change", detail: request.fileName } : null;
    case "shell":
      return supervised || !onlyReads(request) ? { kind: "command", detail: request.fullCommandText } : null;
    case "custom-tool":
      return runsUnasked.has(request.toolName) ? null : { kind: "tool", detail: `${request.toolName} ${JSON.stringify(request.args ?? {})}` };
    case "memory":
      return { kind: "tool", detail: `Remember: ${request.fact}` };
    case "hook":
      return { kind: "tool", detail: `${request.toolName}: ${request.hookMessage ?? "a hook asks to confirm this"}` };
    case "workflow":
      return { kind: "tool", detail: `Workflow ${request.name}: ${request.description}` };
    case "extension-management":
      return { kind: "tool", detail: `Extension ${request.operation}${request.extensionName ? `: ${request.extensionName}` : ""}` };
    case "extension-permission-access":
      return { kind: "tool", detail: `${request.extensionName} asks for ${request.capabilities.join(", ")}` };
    case "extension-env-access":
      return { kind: "tool", detail: `${request.extensionName} asks to read ${request.environmentVariables.join(", ")}` };
    default:
      // A kind a newer runtime adds fails the typecheck here, and asks until it is classified.
      request satisfies never;
      return { kind: "tool", detail: "An action this bot's computer does not know" };
  }
}

// Whether the runtime parsed a shell command as only reading: every command in it
// read-only, and no redirect into a file. A command it could not parse writes.
function onlyReads(request: Extract<PermissionRequest, { kind: "shell" }>) {
  return !request.hasWriteFileRedirection && request.commands.length > 0 && request.commands.every(({ readOnly }) => readOnly);
}
