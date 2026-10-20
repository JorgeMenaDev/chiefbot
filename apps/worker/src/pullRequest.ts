import type { Tool } from "@github/copilot-sdk";
import { ApiError, OpenedPullRequest, PullRequestArgs } from "@chiefbot/contracts";

export const pullRequestToolName = "create_pull_request";

// The bot's one way to open a pull request: a custom Copilot tool that asks
// control, which asks the user and then opens it with the repo app. The
// worker holds no token that could open one itself. The user may take hours to
// answer, so the request has no idle timeout.
// `base` is the computer's control routes (/worker/:id or /task-worker/:id);
// `turnKey` gives the key of the turn its session was opened for (it throws for none).
// An engineer's (`holdsSecret`, secretRedactor.ts) refuses a pull request with one
// of its project's secrets in any field, before control or anyone sees it.
export function pullRequestTool({ base, turnKey, holdsSecret }: { base: string; turnKey: () => string; holdsSecret?: (text: string) => boolean }) {
  return {
    name: pullRequestToolName,
    description: "Open a pull request on GitHub from a branch you already pushed. The user approves it first.",
    parameters: PullRequestArgs,
    async handler(raw) {
      const args = PullRequestArgs.parse(raw);
      if (holdsSecret && Object.values(args).some(holdsSecret)) {
        throw new Error("The pull request holds one of the project's secrets in its repository, branches, title or body. Take it out, then open it again.");
      }
      const res = await fetch(`${base}/pull-requests`, {
        method: "POST",
        headers: { authorization: `Bearer ${turnKey()}`, "content-type": "application/json" },
        body: JSON.stringify(args),
        timeout: false,
      });
      if (!res.ok) {
        const error = ApiError.safeParse(await res.json().catch(() => null));
        throw new Error(error.success ? (error.data.message ?? error.data.error) : `Control answered ${res.status}`);
      }
      const pr = OpenedPullRequest.parse(await res.json());
      return `Opened pull request #${pr.number}: ${pr.url}`;
    },
  } satisfies Tool<PullRequestArgs>;
}
