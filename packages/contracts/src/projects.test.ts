import { expect, test } from "bun:test";
import { ApprovalId, ProjectId, TaskWorkerId } from "./ids.ts";
import { effectiveConfig, ProjectFile, projectState, type Task, type TaskStatus } from "./projects.ts";
import type { TaskWorker, TaskWorkerState } from "./taskWorkers.ts";

test("a project file takes every key, each optional, and refuses unknown ones", () => {
  const full = {
    instructions: ["docs/agents.md"],
    commands: { setup: "bun install", build: "bun run build", test: "bun test", dev: "bun run dev", devUrl: "http://localhost:3000" },
    skills: [".agents/skills/"],
    verify: "verify-app",
    connectors: ["github"],
    mcp: { playwright: { command: "npx", args: ["-y", "@playwright/mcp"] } },
    secrets: ["CLERK_PUBLISHABLE_KEY"],
    workers: { max: 3 },
  };
  expect(ProjectFile.parse(full)).toEqual(full);
  expect(ProjectFile.parse({})).toEqual({});

  for (const wrong of [
    { conectors: ["github"] },
    { commands: { install: "bun install" } },
    { commands: { devUrl: "localhost:3000" } },
    { skills: ["../outside"] },
    { instructions: ["/etc/passwd"] },
    { secrets: ["NOT A NAME"] },
    { mcp: { playwright: { command: "npx", url: "https://example.com" } } },
    { workers: { max: 0 } },
    // As YAML and JSON parse it: an own key, which a record would drop without a word.
    { mcp: JSON.parse('{"__proto__": {"command": "npx"}}') },
  ]) {
    expect(ProjectFile.safeParse(wrong).success).toBe(false);
  }
});

test("settings fill in or override the file key by key, and each key names where it comes from", () => {
  const file = ProjectFile.parse({
    connectors: ["github"],
    commands: { build: "bun run build", test: "bun test" },
    skills: [".agents/skills"],
    workers: { max: 3 },
  });
  const settings = ProjectFile.parse({ commands: { setup: "bun install", test: "bun run test:unit" }, connectors: [], secrets: ["API_KEY"] });

  expect(effectiveConfig(file, settings)).toEqual({
    config: {
      instructions: [],
      commands: { setup: "bun install", build: "bun run build", test: "bun run test:unit" },
      skills: [".agents/skills"],
      connectors: [],
      mcp: {},
      secrets: ["API_KEY"],
      workers: { max: 3 },
    },
    sources: {
      "commands.setup": "settings",
      "commands.build": "file",
      "commands.test": "settings",
      skills: "file",
      connectors: "settings",
      secrets: "settings",
      "workers.max": "file",
    },
  });
});

test("with no project file, the settings and the defaults make the config", () => {
  expect(effectiveConfig(null, {})).toEqual({
    config: { instructions: [], commands: {}, skills: [], connectors: [], mcp: {}, secrets: [], workers: { max: 2 } },
    sources: {},
  });
  expect(effectiveConfig(null, { verify: "verify-app" })).toMatchObject({ config: { verify: "verify-app" }, sources: { verify: "settings" } });
});

test("a project's dot says what most needs a member: their answer, then work going on, then whether it sleeps", () => {
  const task = (status: TaskStatus, requestedBy = "octo-user"): Task => ({
    projectId: ProjectId.parse("project_00000001-0000-4000-8000-000000000000"),
    number: 1,
    title: "Fix the typo",
    detail: "",
    status,
    question: status === "needs_input" ? "Which page?" : null,
    owner: null,
    requestedBy,
    links: [],
    createdAt: 0,
    updatedAt: 0,
  });
  const engineer = (state: TaskWorkerState, pending = false, requestedBy = "octo-user"): TaskWorker => ({
    id: TaskWorkerId.parse("worker_00000001-0000-4000-8000-000000000000"),
    projectId: ProjectId.parse("project_00000001-0000-4000-8000-000000000000"),
    kind: "engineer",
    taskNumber: 1,
    requestedBy,
    payer: null,
    state,
    result: null,
    pullRequest: null,
    sha: null,
    verdict: null,
    pendingApprovals: pending ? [{ approvalId: ApprovalId.parse("approval_1"), kind: "push", detail: "Push fix-typo" }] : [],
    computerRemoved: false,
    screenHolder: null,
    setup: [],
    createdAt: 0,
    updatedAt: 0,
  });
  const quiet = { login: "octo-user", awake: true, busy: false, tasks: [], workers: [] };

  expect(projectState(quiet)).toBe("idle");
  expect(projectState({ ...quiet, awake: false })).toBe("sleeping");
  // A message waiting for the project agent wakes it, so it counts as work.
  expect(projectState({ ...quiet, awake: false, busy: true })).toBe("working");
  expect(projectState({ ...quiet, workers: [engineer("working")] })).toBe("working");
  expect(projectState({ ...quiet, workers: [engineer("launching")] })).toBe("working");
  expect(projectState({ ...quiet, workers: [engineer("setting_up")] })).toBe("working");
  expect(projectState({ ...quiet, workers: [engineer("queued")] })).toBe("idle");
  expect(projectState({ ...quiet, workers: [engineer("finished")], tasks: [task("in_progress")] })).toBe("idle");
  // Only the member who asked answers: a teammate sees the work going on.
  expect(projectState({ ...quiet, busy: true, tasks: [task("needs_input")] })).toBe("needs_you");
  expect(projectState({ ...quiet, tasks: [task("needs_input", "octo-friend")] })).toBe("idle");
  expect(projectState({ ...quiet, awake: false, workers: [engineer("working", true)] })).toBe("needs_you");
  expect(projectState({ ...quiet, workers: [engineer("working", true, "octo-friend")] })).toBe("working");
});
