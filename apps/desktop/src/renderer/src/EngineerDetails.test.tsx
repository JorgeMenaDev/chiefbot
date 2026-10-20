import { expect, test } from "bun:test";
import { TaskWorker, type SetupStep, type StackRow } from "@chiefbot/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { EngineerDetails, setupDisclosure, type SetupChoice } from "./EngineerDetails.tsx";

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

// A stage of the stack: Build, or the template's stage `id`.
const stage = (id: StackRow["id"], label: string, state: StackRow["state"], startedAt: number | null, endedAt: number | null, log = ""): StackRow => ({ id, label, state, log, startedAt, endedAt });
const clone: SetupStep = { step: "clone", command: "git clone https://github.com/octo-org/shop.git shop", exitCode: 0, log: "Cloning into 'shop'...\n", startedAt: 70_000, endedAt: 72_000 };
const install: SetupStep = { step: "setup", command: "bun install", exitCode: 0, log: "3 packages installed\n", startedAt: 72_000, endedAt: 102_000 };

test("an engineer that sets up lists its stack's stages, then its setup steps, as one list: each with its state, how long it took and its log folded away", () => {
  const html = render(
    engineer({
      state: "setting_up",
      stack: [
        stage("build", "Build", "passed", 1_000, 61_000, "built meta\n"),
        stage(0, "Database", "passed", 61_000, 64_500, "postgres is healthy\n"),
        stage(1, "API", "running", Date.now() - 5_000, null),
        stage(2, "Gateway", "waiting", null, null),
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
        stage("build", "Build", "passed", 1_000, 2_000, "built meta\n"),
        stage(1, "API", "failed", 2_000, 14_000, "meta exited with 1: could not connect as acme:***\n"),
        stage(2, "Gateway", "waiting", null, null),
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
      setup: [clone, { step: "setup", command: "bun install --frozen-lockfile", exitCode: 1, log: "error: lockfile had changes\n", startedAt: 72_000, endedAt: 75_000 }],
      result: "Its setup failed: `bun install --frozen-lockfile` exited with 1.",
    }),
  );

  expect(text(html)).toContain("Setup failed");
  expect(rows(html)).toEqual(["Clone passed", "Setup failed"]);
  expect(text(html)).toContain("Clone git clone https://github.com/octo-org/shop.git shop 2.0s");
  expect(text(html)).toContain("Setup bun install --frozen-lockfile exit 1 3.0s");
  expect(html).toMatch(/<details open=""[^]*error: lockfile had changes\n<\/pre><\/details>/);
  expect(html).toContain("Its setup failed: `bun install --frozen-lockfile` exited with 1.");
});

test("a setup step that runs shows running, with how long it has run, after the steps that ended with how long each took", () => {
  const html = render(engineer({ state: "setting_up", setup: [clone, { ...install, exitCode: null, startedAt: Date.now() - 5_000, endedAt: null }] }));

  expect(text(html)).toContain("Setting up: Setup");
  expect(rows(html)).toEqual(["Clone passed", "Setup running"]);
  expect(text(html)).toContain("Clone git clone https://github.com/octo-org/shop.git shop 2.0s");
  expect(text(html)).toMatch(/Setup bun install 5\.\ds/);
});

// The stack of the shipped template, each stage passed.
const upStack = ["Build", "Database", "API", "Gateway", "Seed"].map((label, index) =>
  stage(index === 0 ? "build" : index - 1, label, "passed", index * 1_000, index * 1_000 + 500, `${label} is up\n`),
);

test("once the engineer works, its setup folds away into one line, Ready, and stays folded once it ends", () => {
  for (const state of ["working", "finished"] as const) {
    const html = render(engineer({ state, stack: upStack, setup: [clone, install] }));

    expect(text(html)).toContain("Ready · 7 steps");
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

test("a member's click on the list's first line holds until its setup moves on: a new failure opens the list with its log, and the list folds once the agent works", () => {
  type Setup = Parameters<typeof setupDisclosure>[0];
  const settingUp: Setup = { stack: [stage("build", "Build", "passed", 1_000, 2_000), stage(0, "API", "running", 2_000, null)], steps: [], live: true };
  const apiFailed: Setup = { ...settingUp, stack: settingUp.stack.with(1, stage(0, "API", "failed", 2_000, 9_000, "meta exited with 1\n")) };
  const allUp: Setup = { stack: upStack, steps: [clone, install], live: true };
  // A click on the first line, as SetupProgress keeps it.
  const click = (setup: Setup, choice: SetupChoice | null): SetupChoice => {
    const { phase, open } = setupDisclosure(setup, choice);
    return { phase, open: !open };
  };
  const open = (setup: Setup, choice: SetupChoice | null) => setupDisclosure(setup, choice).open;

  // The member folds the list while API starts, and it stays folded while it does.
  const folded = click(settingUp, null);
  expect([open(settingUp, null), open(settingUp, folded)]).toEqual([true, false]);
  // API fails: the list opens with its log, and opens again once the engineer is blocked.
  expect(open(apiFailed, folded)).toBe(true);
  expect(open({ ...apiFailed, live: false }, click(apiFailed, folded))).toBe(true);

  // The member folds and opens the list while it sets up: it folds once the agent works,
  // and a click then opens it again.
  const reopened = click(allUp, click(allUp, null));
  expect(open(allUp, reopened)).toBe(true);
  const working = { ...allUp, live: false };
  expect(open(working, reopened)).toBe(false);
  expect(open(working, click(working, reopened))).toBe(true);
});
