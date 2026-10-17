import type { Tool } from "@github/copilot-sdk";
import { ApiError, OpenedPullRequest, PullRequestArgs } from "@chiefbot/contracts";

export const pullRequestToolName = "create_pull_request";

// The bot's one way to open a pull request: a custom Copilot tool that asks
// control, which asks the user and then opens it with the GitHub App. The
// worker holds no token that could open one itself. The user may take hours to
// answer, so the request has no idle timeout.
export function pullRequestTool({ controlUrl, botId, botToken }: { controlUrl: string; botId: string; botToken: string }) {
  return {
    name: pullRequestToolName,
    description: "Open a pull request on GitHub from a branch you already pushed. The user approves it first.",
    parameters: PullRequestArgs,
    async handler(raw) {
      const res = await fetch(`${controlUrl}/worker/${botId}/pull-requests`, {
        method: "POST",
        headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
        body: JSON.stringify(PullRequestArgs.parse(raw)),
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
