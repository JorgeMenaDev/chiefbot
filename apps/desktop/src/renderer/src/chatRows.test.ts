import { ApprovalId, type ChatItem } from "@chiefbot/contracts";
import { expect, test } from "bun:test";
import { chatRows, type ChatRow } from "./chatRows.ts";

const user = (id: string): ChatItem => ({ kind: "user", id, text: "Check the project" });
const tool = (id: string, status: "running" | "succeeded" | "failed" = "succeeded"): ChatItem => ({ kind: "tool", id, name: `tool ${id}`, status });
const reply = (id: string, text = "Done."): ChatItem => ({ kind: "assistant", id, text });
const approval = (id: string): ChatItem => ({ kind: "approval", id, approvalId: ApprovalId.parse(id), request: "push", detail: "git push", state: "approved" });

// Each row as its key, with a tools row's calls and whether it is folded.
const shape = (rows: ChatRow[]) => rows.map((row) => (row.kind === "tools" ? `${row.key} [${row.tools.map(({ id }) => id).join(" ")}]${row.folded ? " folded" : ""}` : row.key));

test("before the turn has text, calls made back to back share a row, and an approval starts a new one", () => {
  const items = [user("t1"), tool("t1:c1"), tool("t1:c2", "failed"), approval("t1:a1"), tool("t1:c3", "running")];

  expect(shape(chatRows(items))).toEqual(["t1", "t1:c1 [t1:c1 t1:c2]", "t1:a1", "t1:c3 [t1:c3]"]);
});

test("once the turn has text, its first tools row folds in every call of the turn and keeps its key", () => {
  const working = [user("t1"), tool("t1:c1"), approval("t1:a1"), tool("t1:c2")];
  const answered = [...working, reply("t1:m1"), tool("t1:c3", "running")];

  expect(shape(chatRows(working))[1]).toBe("t1:c1 [t1:c1]");
  expect(shape(chatRows(answered))).toEqual(["t1", "t1:c1 [t1:c1 t1:c2 t1:c3] folded", "t1:a1", "t1:m1"]);
});

test("every row keeps its key as a turn streams, and a reply that is only whitespace folds nothing", () => {
  const steps = [[user("t1"), reply("t1:m1", "  ")], [user("t1"), reply("t1:m1", "  "), tool("t1:c1")], [user("t1"), reply("t1:m1", "  On it."), tool("t1:c1")]];
  const keys = steps.map((items) => chatRows(items).map((row) => row.key));

  expect(keys).toEqual([["t1", "t1:m1"], ["t1", "t1:m1", "t1:c1"], ["t1", "t1:m1", "t1:c1"]]);
  expect(shape(chatRows(steps[1] ?? []))).toContain("t1:c1 [t1:c1]");
});

test("a turn's calls never fold into an earlier turn", () => {
  const items = [user("t1"), tool("t1:c1"), reply("t1:m1"), user("t2"), tool("t2:c1")];

  expect(shape(chatRows(items))).toEqual(["t1", "t1:c1 [t1:c1] folded", "t1:m1", "t2", "t2:c1 [t2:c1]"]);
});

test("a turn control started, shown as a notice, keeps its calls out of the turn before it", () => {
  const notice = (id: string): ChatItem => ({ kind: "notice", id, text: "Engineer for task #1 ended: opened a pull request." });
  const items = [user("t1"), tool("t1:c1"), reply("t1:m1"), notice("t2"), tool("t2:c1"), reply("t2:m1")];

  expect(shape(chatRows(items))).toEqual(["t1", "t1:c1 [t1:c1] folded", "t1:m1", "t2", "t2:c1 [t2:c1] folded", "t2:m1"]);
});
