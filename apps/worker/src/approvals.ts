import type { PermissionRequest } from "@github/copilot-sdk";
import type { ApprovalKind } from "@chiefbot/contracts";
import { PullRequestArgs, pullRequestToolName } from "./pullRequest.ts";

// Shell commands the user approves first: anything that publishes work or
// changes GitHub. Matched anywhere in the command, so `cd x && git push` and
// `bash -c "git push"` ask too; a commit message that says "push" asks as well.
const riskyCommands = [/\bgit\b.*\bpush\b/, /\bgh\s+pr\s+(create|merge)\b/, /\bgh\s+repo\s+delete\b/];

// What the user must approve before the Copilot runtime may do `request`, or null
// when it runs without asking. Everything else in the bot's own computer (reading,
// editing, other commands) runs freely: the computer is the bot's sandbox.
export function approvalFor(request: PermissionRequest): { kind: ApprovalKind; detail: string } | null {
  switch (request.kind) {
    case "shell":
      return riskyCommands.some((risky) => risky.test(request.fullCommandText))
        ? { kind: "command", detail: request.fullCommandText }
        : null;
    case "custom-tool": {
      if (request.toolName !== pullRequestToolName) return null;
      const args = PullRequestArgs.safeParse(request.args);
      const detail = args.success
        ? `${args.data.repository}: ${args.data.head} → ${args.data.base}\n${args.data.title}`
        : JSON.stringify(request.args);
      return { kind: "pull-request", detail };
    }
    case "mcp":
      return request.readOnly ? null : { kind: "tool", detail: `${request.serverName}: ${request.toolTitle}` };
    default:
      return null;
  }
}
