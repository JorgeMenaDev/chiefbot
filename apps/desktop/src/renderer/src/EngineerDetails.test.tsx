import { expect, test } from "bun:test";
import { TaskWorker } from "@chiefbot/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { EngineerDetails } from "./EngineerDetails.tsx";

const engineer = (fields: Partial<TaskWorker>) =>
  TaskWorker.parse({
    id: "worker_1",
    projectId: "project_1",
    taskNumber: 1,
    requestedBy: "octo-user",
    payer: null,
    state: "working",
    setup: [],
    result: null,
    pullRequest: null,
    pendingApprovals: [],
    computerRemoved: false,
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  });

const render = (worker: TaskWorker) => renderToStaticMarkup(<EngineerDetails worker={worker} max={2} />);

test("a blocked engineer shows each setup step with its exit code, the failing step's log open, and why it stopped", () => {
  const html = render(
    engineer({
      state: "blocked",
      setup: [
        { step: "clone", command: "git clone https://github.com/octo-org/shop.git shop", exitCode: 0, log: "Cloning into 'shop'...\n" },
        { step: "setup", command: "bun install --frozen-lockfile", exitCode: 1, log: "error: lockfile had changes\n" },
      ],
      result: "Its setup failed: `bun install --frozen-lockfile` exited with 1.",
    }),
  );

  expect(html).toContain("<details><summary");
  expect(html).toContain("clone: git clone https://github.com/octo-org/shop.git shop · exit 0");
  expect(html).toContain("<details open=\"\"><summary");
  expect(html).toContain("setup: bun install --frozen-lockfile · exit 1");
  expect(html).toContain("error: lockfile had changes\n</pre>");
  expect(html).toContain("Its setup failed: `bun install --frozen-lockfile` exited with 1.");
});

test("a queued engineer says what it waits for, and one that finished with no pull request shows its report", () => {
  expect(render(engineer({ state: "queued" }))).toContain("This project runs 2 engineers at once: it starts when one ends.");
  expect(renderToStaticMarkup(<EngineerDetails worker={engineer({ state: "queued" })} max={1} />)).toContain("This project runs 1 engineer at once:");

  const report = render(engineer({ state: "finished", result: "**Nothing to change**: the typo is already fixed on main." }));

  expect(report).toContain("<strong>Nothing to change</strong>: the typo is already fixed on main.");
});
