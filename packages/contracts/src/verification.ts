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

// What one verdict may carry: at most this many screenshots, each a PNG of at most this many bytes.
export const VERDICT_SCREENSHOTS_MAX = 6;
export const SCREENSHOT_BYTES_MAX = 2 * 1024 * 1024;

// Whether `bytes` start as every PNG file does.
export const isPng = (bytes: Uint8Array) => pngSignature.every((byte, at) => bytes[at] === byte);
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// The verifier's report_verdict tool: its verdict on the commit it checked.
export const VerdictArgs = z.object({
  result: VerdictResult.describe("pass: the change does what the task asks. issues: it does not. blocked: you could not check it"),
  summary: z.string().min(1).max(1000).describe("One or two sentences: what works, the issues, or why you could not check it"),
  report: z.string().max(20_000).default("").describe("What you checked and what you saw, step by step, in Markdown"),
  screenshots: z
    .array(z.string().min(1))
    .max(VERDICT_SCREENSHOTS_MAX)
    .default([])
    .describe("Paths of the PNG screenshots you saved, such as /tmp/verify-1.png"),
});
export type VerdictArgs = z.infer<typeof VerdictArgs>;

// Body of POST /task-worker/:workerId/verdict: the verdict, the project's
// secrets hidden in its text, and each screenshot's bytes as base64.
export const VerdictReport = VerdictArgs.extend({
  screenshots: z
    .array(z.base64().max(Math.ceil(SCREENSHOT_BYTES_MAX / 3) * 4))
    .max(VERDICT_SCREENSHOTS_MAX),
});
export type VerdictReport = z.infer<typeof VerdictReport>;
