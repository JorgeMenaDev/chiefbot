import { z } from "zod";

// A verifier checks a task's pull request at one commit, on a fresh computer,
// and ends with a verdict:
//   pass     the change works as the task asks
//   issues   it does not: the summary names what is wrong
//   blocked  the verifier could not check it (its setup failed, the app would not start…)
export const VerdictResult = z.enum(["pass", "issues", "blocked"]);
export type VerdictResult = z.infer<typeof VerdictResult>;

// A commit as git names it in full.
export const CommitSha = z.string().regex(/^[0-9a-f]{40}$/, "expected a full commit SHA");

// A verdict in a line: the result, the commit it was given at, whether the pull
// request's head has moved since (`stale`), and its summary (what passed, the
// issues, or why it was blocked). What a chief's handoff card shows.
export const VerdictLine = z.object({ result: VerdictResult, sha: CommitSha, stale: z.boolean(), summary: z.string() });
export type VerdictLine = z.infer<typeof VerdictLine>;
