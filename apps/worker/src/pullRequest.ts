import type { Tool } from "@github/copilot-sdk";
import { z } from "zod";

export const PullRequestArgs = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe("The GitHub repository as owner/name"),
  head: z.string().min(1).describe("The branch with the changes. Push it first."),
  base: z.string().min(1).describe("The branch to merge into, usually the default branch"),
  title: z.string().min(1),
  body: z.string().default(""),
});
export type PullRequestArgs = z.infer<typeof PullRequestArgs>;

const PullRequestResponse = z.object({ number: z.number().int(), html_url: z.string() });

export const pullRequestToolName = "create_pull_request";

// The bot's one way to open a pull request: a custom Copilot tool that calls the
// GitHub API with the owner's brokered token. It is not marked skipPermission, so
// every call goes through the session's permission handler (approvals.ts).
export function pullRequestTool({ githubApiUrl, token }: { githubApiUrl: string; token: () => Promise<string> }) {
  return {
    name: pullRequestToolName,
    description: "Open a pull request on GitHub from a branch you already pushed. The user approves it first.",
    parameters: PullRequestArgs,
    async handler(raw) {
      const { repository, head, base, title, body } = PullRequestArgs.parse(raw);
      const res = await fetch(`${githubApiUrl}/repos/${repository}/pulls`, {
        method: "POST",
        headers: { authorization: `Bearer ${await token()}`, accept: "application/vnd.github+json" },
        body: JSON.stringify({ head, base, title, body }),
      });
      if (!res.ok) throw new Error(`GitHub refused the pull request (${res.status}): ${await res.text()}`);
      const pr = PullRequestResponse.parse(await res.json());
      return `Opened pull request #${pr.number}: ${pr.html_url}`;
    },
  } satisfies Tool<PullRequestArgs>;
}
