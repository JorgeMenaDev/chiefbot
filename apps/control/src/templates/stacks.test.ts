import { expect, test } from "bun:test";
import { SETUP_LOG_MAX, TaskWorkerId } from "@chiefbot/contracts";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTemplates, repoTemplates } from "./catalog.ts";
import { dockerStacks, stackModel, type StackReport } from "./stacks.ts";

test("a stage's log keeps the end of what its steps print, every secret hidden before the cut: one the cut lands inside too", async () => {
  const token = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";
  const password = "hunter2-dev";
  // A docker CLI that prints the token, whose start falls before the log's last
  // SETUP_LOG_MAX characters and whose last 20 inside them, then the project's
  // secret, then fails. No Docker is reached.
  const bin = mkdtempSync(join(tmpdir(), "acme-stacks-test-"));
  writeFileSync(join(bin, "printed"), `${"a".repeat(100)}${token}\n${password}\n${"b".repeat(SETUP_LOG_MAX - 33)}`);
  writeFileSync(join(bin, "docker"), `#!/bin/sh\ncat "${join(bin, "printed")}"\nexit 1\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const stacks = dockerStacks({ socketPath: join(bin, "no.sock"), githubUrl: "http://127.0.0.1:9", templatesDir: repoTemplates, prefix: "acme-stacktest-" });
  process.env.PATH = path;
  const template = loadTemplates(repoTemplates).find(({ name }) => name === "java-react-enterprise");
  if (!template) throw new Error("no java-react-enterprise template");
  const reports: StackReport[] = [];

  try {
    const outcome = await stacks.start(
      TaskWorkerId.parse("worker_a"),
      { template, own: "ui", repos: { auth: { repo: "octo-org/acme-auth", ref: "main", token } }, secrets: [password] },
      (stage) => reports.push(stage),
    );

    expect(outcome).toBe("failed");
    expect(reports.map(({ label, state }) => `${label} ${state}`)).toEqual(["Build running", "Build failed"]);
    expect(reports.at(-1)?.log).toBe(`${"a".repeat(25)}***\n***\n${"b".repeat(SETUP_LOG_MAX - 33)}`);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("the stack's compose model leaves out the project's own service, and every wait on it or on the seed, in services nothing starts too and in either form of depends_on", () => {
  const healthy = { condition: "service_healthy" };
  const model = stackModel(
    {
      name: "acme",
      networks: { default: {} },
      services: {
        ui: { build: { context: "/t/ui" }, network_mode: "service:pod", depends_on: { seed: { condition: "service_completed_successfully" } } },
        seed: { image: "acme-seed:local", depends_on: { auth: healthy } },
        auth: { image: "acme-auth:local", expose: ["8081"] },
        // In no stage: nothing starts it, and it needs the project's own service.
        diagnostic: { image: "acme-diagnostic:local", depends_on: { ui: { condition: "service_started" }, auth: healthy } },
        probe: { image: "acme-probe:local", depends_on: ["ui", "seed", "auth"] },
      },
    },
    { computer: "chiefbot-worker_a", own: "ui", seed: "seed", images: {} },
  );

  const joined = { network_mode: "container:chiefbot-worker_a" };
  expect(model.services).toEqual({
    seed: { image: "acme-seed:local", ...joined, depends_on: { auth: healthy } },
    auth: { image: "acme-auth:local", ...joined },
    diagnostic: { image: "acme-diagnostic:local", ...joined, depends_on: { auth: healthy } },
    probe: { image: "acme-probe:local", ...joined, depends_on: ["auth"] },
  });
  // The project's other keys stay, but its networks: every service is in the computer's.
  expect(model).toHaveProperty("name", "acme");
  expect(model).not.toHaveProperty("networks");
});
