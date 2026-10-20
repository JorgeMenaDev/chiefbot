import { expect, test } from "bun:test";
import { TaskWorker, type StackRow } from "@chiefbot/contracts";
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
// The markup's text, one space between pieces.
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
// Each row of the setup list: its label and state.
const rows = (html: string) => [...html.matchAll(/data-state="(\w+)"[^>]*data-label="([^"]+)"/g)].map(([, state, label]) => `${label} ${state}`);

const stage = (label: string, state: StackRow["state"], startedAt: number | null, endedAt: number | null, log = ""): StackRow => ({ label, state, log, startedAt, endedAt });
const clone = { step: "clone" as const, command: "git clone https://github.com/octo-org/shop.git shop", exitCode: 0, log: "Cloning into 'shop'...\n" };
const install = { step: "setup" as const, command: "bun install", exitCode: 0, log: "3 packages installed\n" };

test("an engineer that sets up lists its stack's stages, then its setup steps, as one list: each with its state, how long it took and its log folded away", () => {
  const html = render(
    engineer({
      state: "setting_up",
      stack: [
        stage("Build", "passed", 1_000, 61_000, "built meta\n"),
        stage("Database", "passed", 61_000, 64_500, "postgres is healthy\n"),
        stage("API", "running", Date.now() - 5_000, null),
        stage("Gateway", "waiting", null, null),
      ],
    }),
  );

  expect(text(html)).toContain("Setting up: API");
  expect(rows(html)).toEqual(["Build passed", "Database passed", "API running", "Gateway waiting"]);
  expect(text(html)).toContain("Build 1m");
  expect(text(html)).toContain("Database 3.5s");
  expect(html).toContain("built meta\n</pre></details>");
  expect(html).not.toContain("<details open");
});

test("a failed stage opens its log as it is, secrets hidden, the stages after it show they never ran, and the engineer says why it is blocked", () => {
  const html = render(
    engineer({
      state: "blocked",
      stack: [
        stage("Build", "passed", 1_000, 2_000, "built meta\n"),
        stage("API", "failed", 2_000, 14_000, "meta exited with 1: could not connect as acme:***\n"),
        stage("Gateway", "waiting", null, null),
      ],
      result: "Its stack did not start: its API stage failed.",
    }),
  );

  expect(text(html)).toContain("API failed");
  expect(rows(html)).toEqual(["Build passed", "API failed", "Gateway waiting"]);
  expect(html).toMatch(/<details open=""[^]*meta exited with 1: could not connect as acme:\*\*\*\n<\/pre><\/details>/);
  expect(text(html)).toContain("Gateway not run");
  expect(html).toContain("Its stack did not start: its API stage failed.");
});

test("a blocked engineer shows each setup step with its command, the failing step's log open with its exit code, and why it stopped", () => {
  const html = render(
    engineer({
      state: "blocked",
      setup: [clone, { step: "setup", command: "bun install --frozen-lockfile", exitCode: 1, log: "error: lockfile had changes\n" }],
      result: "Its setup failed: `bun install --frozen-lockfile` exited with 1.",
    }),
  );

  expect(text(html)).toContain("Setup failed");
  expect(rows(html)).toEqual(["Clone passed", "Setup failed"]);
  expect(text(html)).toContain("Clone git clone https://github.com/octo-org/shop.git shop");
  expect(text(html)).toContain("Setup bun install --frozen-lockfile exit 1");
  expect(html).toMatch(/<details open=""[^]*error: lockfile had changes\n<\/pre><\/details>/);
  expect(html).toContain("Its setup failed: `bun install --frozen-lockfile` exited with 1.");
});

test("once the engineer works, its setup folds away into one line, and stays folded once it ends", () => {
  const stack = ["Build", "Database", "API", "Gateway", "Seed"].map((label, index) => stage(label, "passed", index * 1_000, index * 1_000 + 500, `${label} is up\n`));

  for (const state of ["working", "finished"] as const) {
    const html = render(engineer({ state, stack, setup: [clone, install] }));

    expect(text(html)).toContain("Set up · 7 steps");
    expect(rows(html)).toEqual([]);
    expect(html).not.toContain("is up");
  }
});

test("a queued engineer says what it waits for, and one that finished with no pull request shows its report", () => {
  expect(render(engineer({ state: "queued" }))).toContain("This project runs 2 engineers and verifiers at once: it starts when one ends.");
  expect(renderToStaticMarkup(<EngineerDetails worker={engineer({ state: "queued" })} max={1} />)).toContain("This project runs 1 engineer or verifier at once:");

  const report = render(engineer({ state: "finished", result: "**Nothing to change**: the typo is already fixed on main." }));

  expect(report).toContain("<strong>Nothing to change</strong>: the typo is already fixed on main.");
});
