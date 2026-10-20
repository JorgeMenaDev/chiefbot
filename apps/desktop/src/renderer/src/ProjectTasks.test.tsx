import { expect, test } from "bun:test";
import { Project, Task, type TaskLink, type Verification } from "@chiefbot/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskLedger } from "./ProjectTasks.tsx";

const project = Project.parse({
  id: "project_1",
  workspaceId: "workspace_1",
  name: "shop",
  repo: "octo-org/shop",
  file: { status: "missing" },
  settings: "",
  config: {},
  sources: {},
  model: "auto",
  effort: null,
});
const pr = (number: number): TaskLink => ({ kind: "pull-request", url: `https://github.com/octo-org/shop/pull/${number}` });
const verified = (fields: Partial<Verification>): Verification => ({
  result: "pass",
  sha: "abc1234def5678abc1234def5678abc1234def56",
  stale: false,
  testsOnly: false,
  summary: "The README reads The shop.",
  pullRequest: "https://github.com/octo-org/shop/pull/1",
  branch: "fix-typo",
  evidence: "verify/task-1-abc1234-0a1b2c3d.md" as Verification["evidence"],
  worker: "worker_1" as Verification["worker"],
  at: 1,
  ...fields,
});
const task = (number: number, fields: Partial<Task>) =>
  Task.parse({ projectId: "project_1", number, title: `Task ${number}`, detail: "", status: "in_progress", question: null, owner: null, requestedBy: "octo-user", links: [pr(1)], createdAt: 1, updatedAt: 1, ...fields });
const render = (tasks: Task[]) =>
  renderToStaticMarkup(<TaskLedger project={project} login="octo-user" tasks={tasks} workers={[]} onWatch={() => {}} onEvidence={() => {}} />);

test("a task shows its verifier's verdict on its latest pull request: PASS at its commit, tests only, stale once the pull request moved, or the issues", () => {
  const html = render([
    task(1, { verification: verified({}) }),
    task(2, { verification: verified({ stale: true }) }),
    task(3, { verification: verified({ result: "issues", summary: "The README still says Teh." }) }),
    task(4, { links: [pr(1), pr(2)], verification: verified({}) }),
    task(5, { verification: verified({ testsOnly: true }) }),
  ]);

  expect(html).toContain("Verified PASS @abc1234<");
  expect(html).toContain("Verified PASS @abc1234 · stale");
  expect(html).toContain("ISSUES @abc1234: The README still says Teh.");
  expect(html).toContain("Verified PASS @abc1234 · tests only<");
  expect(html.match(/Verified PASS/g)).toHaveLength(3);
  expect(html.match(/>Report</g)).toHaveLength(4);
});

test("an open task with a pull request can be marked done by a member, and a task marked so says who did and its verdict then", () => {
  const open = render([task(1, {})]);
  const marked = render([task(1, { status: "done", overrides: [{ by: "octo-friend", at: 1, verification: verified({ result: "issues", summary: "Teh." }) }] })]);
  const unverified = render([task(1, { status: "done", overrides: [{ by: "octo-friend", at: 1, verification: null }] })]);

  expect(open).toContain("Mark done");
  expect(marked).not.toContain("Mark done");
  expect(marked).toContain("Marked done in the app by octo-friend · ISSUES @abc1234");
  expect(unverified).toContain("Marked done in the app by octo-friend · not verified");
});
