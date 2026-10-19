import { afterEach, expect, test } from "bun:test";
import type { AgentConnection } from "@chiefbot/contracts";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalFor } from "./approvals.ts";
import { connectionCalls, stageConnections } from "./connections.ts";
import { fakeRequest } from "./fakeCopilot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "chiefbot-worker-"));
  dirs.push(dir);
  return dir;
};

const jira: AgentConnection = {
  name: "jira",
  title: "Jira",
  cli: "acli",
  skill: "---\nname: jira\ndescription: Jira.\n---\nUse acli.\n",
  fields: { site: "example.atlassian.net", token: "it's-secret" },
  env: { HOME: "{dir}", JIRA_SITE: "https://{site}/" },
  readOnly: ["acli jira auth *", "acli jira workitem view *", "acli jira workitem search *"],
};

test("a turn's connection is staged as owner-only files, a skill and a wrapper that runs the CLI as the person, and goes with the turn", async () => {
  const root = join(tempDir(), "chiefbot");
  const tools = tempDir();
  writeFileSync(join(tools, "acli"), '#!/bin/sh\necho "acli $* home=$HOME site=$JIRA_SITE path=$PATH"\n');
  chmodSync(join(tools, "acli"), 0o755);

  const staged = stageConnections(root, [jira]);
  const dir = join(root, "connections/jira");
  const mode = (path: string) => statSync(path).mode & 0o777;

  expect(staged.skillDirectories).toEqual([join(root, "skills")]);
  expect(readFileSync(join(root, "skills/jira/SKILL.md"), "utf8")).toBe(jira.skill);
  expect([readFileSync(join(dir, "token"), "utf8"), mode(join(dir, "token")), mode(dir), mode(root)]).toEqual(["it's-secret", 0o600, 0o700, 0o700]);
  expect(mode(join(root, "bin/acli"))).toBe(0o700);
  // The agent's shell has the wrappers first on its PATH; the wrapper finds the real CLI behind it.
  const run = Bun.spawnSync(["sh", "-c", "acli jira workitem view CHIEF-1"], { env: { PATH: `${root}/bin:${tools}:/usr/bin:/bin` } });
  expect(run.stdout.toString()).toBe(`acli jira workitem view CHIEF-1 home=${dir} site=https://example.atlassian.net/ path=${tools}:/usr/bin:/bin\n`);

  staged.cleanup();
  expect(existsSync(root)).toBe(false);
});

test("no connection, no skill root", () => {
  const root = join(tempDir(), "chiefbot");
  expect(stageConnections(root, []).skillDirectories).toEqual([]);
});

test("a command of a connection's CLI that matches none of its read-only globs asks; reads and other commands do not", () => {
  const ask = (command: string) => approvalFor(fakeRequest.shell(command), [jira]);

  expect(ask('acli jira workitem create --summary "Ship it" --project CHIEF --type Task')).toEqual({
    kind: "connector",
    detail: 'Jira: acli jira workitem create --summary "Ship it" --project CHIEF --type Task',
  });
  expect(ask("acli jira workitem view CHIEF-1")).toBeNull();
  expect(ask("acli jira auth login --site x --email y --token < /tmp/chiefbot/connections/jira/token")).toBeNull();
  expect(ask("ls -la && git status")).toBeNull();
  // Every segment counts, whatever runs before it, and however the CLI is named.
  expect(ask("acli jira workitem view CHIEF-1 && acli jira workitem delete --key CHIEF-1")?.detail).toBe("Jira: acli jira workitem delete --key CHIEF-1");
  expect(ask("/tmp/chiefbot/bin/acli jira workitem transition --key CHIEF-1 --status Done")?.kind).toBe("connector");
  expect(ask("DEBUG=1 acli jira workitem edit --key CHIEF-1")?.kind).toBe("connector");
  // Without parsed segments, any command naming the CLI asks.
  const unparsed = fakeRequest.shell("acli jira workitem view CHIEF-1");
  if (unparsed.kind === "shell") delete unparsed.commandSegments;
  expect(approvalFor(unparsed, [jira])?.kind).toBe("connector");
});

test("each command of a connection's CLI is logged as the CLI and its subcommands, without flags or values", () => {
  expect(connectionCalls(fakeRequest.shell("acli jira workitem view CHIEF-1 | head -5 ; git log"), [jira])).toEqual([
    { connection: jira, command: "acli jira workitem view CHIEF-1", logged: "acli jira workitem view", readOnly: true },
  ]);
});
