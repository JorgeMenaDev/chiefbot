import type { PermissionRequest } from "@github/copilot-sdk";
import type { ApprovalKind } from "@chiefbot/contracts";
import { PullRequestArgs, pullRequestToolName } from "./pullRequest.ts";

// Shell commands the user approves first: anything that publishes work, changes
// GitHub, or skips the pre-push hook. Matched anywhere in the normalised command,
// so `cd x && git push` and `bash -c "git push"` ask too; a commit message that
// says "push" asks as well. A shell can spell a command in ways no regex sees
// (`p=push; git $p`), so this is only the early prompt: every git push also asks
// through the image's pre-push hook (prePush.ts), and gh has no token.
const riskyCommands = [
  /\bgit\b.*\bpush\b/,
  /\bgh\b.*\bpr\s+(create|merge)\b/,
  /\bgh\b.*\brepo\s+delete\b/,
  // A pull request through the REST API: a write (an explicit POST or fields) to /pulls.
  /\bgh\b.*\bapi\b(?=.*\/pulls\b)(?=.*(-X\s*POST|--method[=\s]POST|\s-[fF]\s|--(raw-)?field\b|--input\b))/i,
  /\bcreatePullRequest\b/,
  /--no-verify\b/,
  /\bcore\.hookspath\b/i,
  /\bGIT_CONFIG_(COUNT|KEY_\d+|PARAMETERS)\b/,
];

// The command as the shell would mostly read it: quotes and backslashes removed,
// whitespace collapsed. `git p\ush` and `git "push"` become `git push`.
const normalise = (command: string) => command.replace(/["'\\]/g, "").replace(/\s+/g, " ");

// What the user must approve before the Copilot runtime may do `request`, or null
// when it runs without asking. Everything else in the bot's own computer (reading,
// editing, other commands) runs freely: the computer is the bot's sandbox.
export function approvalFor(request: PermissionRequest): { kind: ApprovalKind; detail: string } | null {
  switch (request.kind) {
    case "shell":
      return riskyCommands.some((risky) => risky.test(normalise(request.fullCommandText)))
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
