import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ApprovalId, DEFAULT_AVATAR, ProjectId, TaskWorkerId, TurnId, UserId, WorkspaceId } from "@chiefbot/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.ts";
import { atCleanUp, cleanUp } from "./testControl.ts";

afterEach(cleanUp);

test("a database the first v0.2 build made opens and keeps working: new columns are added, stale project file keys dropped, an old project file reads as found, its users get no first bot, its bots get the default face", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chiefbot-upgrade-"));
  atCleanUp(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "control.sqlite");
  const old = new Database(path);
  old.run(await Bun.file(new URL("./upgrade.fixture.sql", import.meta.url)).text());
  old.run("INSERT INTO bots (id, user_id, name, token_hash, running, created_at) VALUES ('bot_1', 'user_1', 'Ada', 'hash_1', 0, 1)");
  old.close();

  const store = openStore(path);
  const projectId = ProjectId.parse("project_1");
  const workspaceId = WorkspaceId.parse("workspace_1");
  const workerId = TaskWorkerId.parse("worker_1");

  // Its project file, stored before a missing file was allowed, still reads, and it has no settings yet.
  expect(store.projects.project(projectId)).toMatchObject({
    file: { status: "found", file: { connectors: ["tracker"], commands: {} } },
    settings: "",
    config: { connectors: ["tracker"] },
  });
  expect(store.projects.secretNames(projectId)).toEqual([]);
  expect(store.connectors.get(workspaceId, "tracker")?.writesWithoutApproval).toBe(false);
  store.connectors.setWritesWithoutApproval(workspaceId, "tracker", true);
  expect(store.connectors.get(workspaceId, "tracker")?.writesWithoutApproval).toBe(true);
  // The pending approval from before the upgrade still belongs to the worker's turn, and a new one is kept beside it.
  store.taskWorkers.requestApproval(workerId, TurnId.parse("turn_1"), { approvalId: ApprovalId.parse("approval_2"), kind: "tool", detail: "gh pr create" }, 5);
  expect(store.taskWorkers.workerIn(projectId, workerId)?.pendingApprovals.map(({ detail }) => detail)).toEqual(["git push", "gh pr create"]);
  // A bot from before faces wears the default one.
  expect(store.botFor(UserId.parse("user_1"), "bot_1")?.avatar).toEqual(DEFAULT_AVATAR);
  // A user from before first bots never gets one.
  expect(store.claimFirstBot(UserId.parse("user_1"))).toBe(false);
});
