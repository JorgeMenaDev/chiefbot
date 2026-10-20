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
    template: "java-react-enterprise",
    service: "ui",
    services: { meta: { repo: "octo-org/meta-api", ref: "main" }, auth: "stand-in" },
  } satisfies ProjectFile;
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
    { services: JSON.parse('{"__proto__": "stand-in"}') },
    { template: "Java React" },
    { service: ["ui"] },
    { services: { meta: { repo: "octo-org/meta-api" } } },
    { services: { meta: { repo: "meta-api", ref: "main" } } },
    { services: { meta: { repo: "octo-org/meta-api", ref: "main", context: "." } } },
    { services: { meta: { repo: "octo-org/meta-api", ref: "../main" } } },
    { services: { meta: { repo: "octo-org/meta-api", ref: "-main" } } },
    { services: { meta: "standin" } },
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
      services: {},
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

test("a template, the project's own service and the other services come from the settings or the file, each whole", () => {
  const file = ProjectFile.parse({
    template: "java-react-enterprise",
    service: "ui",
    services: { meta: { repo: "octo-org/meta-api", ref: "main" }, auth: { repo: "octo-org/gateway", ref: "v2" } },
  });
  const settings = ProjectFile.parse({ services: { meta: { repo: "octo-org/meta-api", ref: "fix/login" } } });

  expect(effectiveConfig(file, settings)).toMatchObject({
    // The settings' services replace the file's: auth is back on its stand-in.
    config: { template: "java-react-enterprise", service: "ui", services: { meta: { repo: "octo-org/meta-api", ref: "fix/login" } } },
    sources: { template: "file", service: "file", services: "settings" },
  });
  expect(effectiveConfig(null, { template: "java-react-enterprise", service: "ui" })).toMatchObject({
    config: { template: "java-react-enterprise", service: "ui", services: {} },
    sources: { template: "settings", service: "settings" },
  });
});

test("template: null in the settings turns the file's template off, and its service and services with it", () => {
  const file = ProjectFile.parse({ template: "java-react-enterprise", service: "ui", services: { auth: "stand-in" }, workers: { max: 3 } });
  const settings = ProjectFile.parse({ template: null });

  const { config, sources } = effectiveConfig(file, settings);

  expect([config.template, config.service, config.services, config.workers.max]).toEqual([undefined, undefined, {}, 3]);
  expect(sources).toEqual({ template: "settings", "workers.max": "file" });
});

test("with no project file, the settings and the defaults make the config", () => {
  expect(effectiveConfig(null, {})).toEqual({
    config: { instructions: [], commands: {}, skills: [], connectors: [], mcp: {}, secrets: [], workers: { max: 2 }, services: {} },
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
    verification: null,
    overrides: [],
    createdAt: 0,
    updatedAt: 0,
  });
  const engineer = (state: TaskWorkerState, pending = false, requestedBy = "octo-user"): TaskWorker => ({
    id: TaskWorkerId.parse("worker_00000001-0000-4000-8000-000000000000"),
    projectId: ProjectId.parse("project_00000001-0000-4000-8000-000000000000"),
    kind: "engineer",
    branch: null,
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
    stack: [],
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
