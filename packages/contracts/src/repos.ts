import { z } from "zod";

// A GitHub repository as owner/name. Control puts it in GitHub URLs with its
// own tokens, so "." and ".." names, which would walk to other paths, are refused.
export const RepoFullName = z
  .string()
  .regex(/^[\w-][\w.-]*\/[\w.-]+$/)
  .refine((fullName) => !/\/\.\.?$/.test(fullName), "not a repository name");

// Body of POST /worker/:botId/pull-requests: the bot's create_pull_request tool
// asks control, which asks the user and then opens it with the repo app.
export const PullRequestArgs = z.object({
  repository: RepoFullName.describe("The GitHub repository as owner/name"),
  head: z.string().min(1).describe("The branch with the changes. Push it first."),
  base: z.string().min(1).describe("The branch to merge into, usually the default branch"),
  title: z.string().min(1),
  body: z.string().default(""),
});
export type PullRequestArgs = z.infer<typeof PullRequestArgs>;

// The 201 answer: the pull request control opened.
export const OpenedPullRequest = z.object({ number: z.number().int(), url: z.string() });
export type OpenedPullRequest = z.infer<typeof OpenedPullRequest>;
