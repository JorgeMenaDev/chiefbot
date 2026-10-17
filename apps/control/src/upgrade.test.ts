import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ApprovalId, ProjectId, TaskWorkerId, WorkspaceId } from "@chiefbot/contracts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.ts";

test("a database the first v0.2 build made opens and keeps working: new columns are added, stale project file keys dropped", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "chiefbot-upgrade-")), "control.sqlite");
  const old = new Database(path);
  old.run(await Bun.file(new URL("./upgrade.fixture.sql", import.meta.url)).text());
  old.close();

  const store = openStore(path);
  const projectId = ProjectId.parse("project_1");
  const workspaceId = WorkspaceId.parse("workspace_1");
  const workerId = TaskWorkerId.parse("worker_1");

  expect(store.projects.project(projectId)?.file).toEqual({ connectors: ["tracker"], commands: {} });
  expect(store.connectors.get(workspaceId, "tracker")?.writesWithoutApproval).toBe(false);
  store.connectors.setWritesWithoutApproval(workspaceId, "tracker", true);
  expect(store.connectors.get(workspaceId, "tracker")?.writesWithoutApproval).toBe(true);
  // The pending approval from before the upgrade still belongs to the worker's turn, and a new one is kept beside it.
  store.taskWorkers.requestApproval(workerId, { approvalId: ApprovalId.parse("approval_2"), kind: "tool", detail: "gh pr create" }, 5);
  expect(store.taskWorkers.workerIn(projectId, workerId)?.pendingApprovals.map(({ detail }) => detail)).toEqual(["git push", "gh pr create"]);
});
