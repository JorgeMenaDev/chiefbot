import { expect, test } from "bun:test";
import { AccessMode, type AgentConnection, type ApprovalKind } from "@chiefbot/contracts";
import type { PermissionRequest } from "@github/copilot-sdk";
import { approvalFor } from "./approvals.ts";
import { fakeRequest } from "./fakeCopilot.ts";

test("a GitHub tool that writes asks the user; one that only reads does not", () => {
  expect(approvalFor(fakeRequest.mcp("github", "Merge pull request", false))).toEqual({
    kind: "tool",
    detail: "github: Merge pull request",
  });
  expect(approvalFor(fakeRequest.mcp("github", "Get file contents", true))).toBeNull();
});

const jira: AgentConnection = {
  name: "jira",
  title: "Jira",
  cli: "acli",
  skill: "",
  fields: {},
  env: {},
  readOnly: ["acli jira workitem view *"],
};

// Each kind of permission request, and what each access mode asks for it
// (the approval's kind, or "runs"), in the order supervised, auto-accept-edits, auto, full-access.
type Asks = ApprovalKind | "runs";
const cases: Array<[string, PermissionRequest, [Asks, Asks, Asks, Asks]]> = [
  ["a command that only reads", fakeRequest.readOnlyShell("ls -la"), ["command", "runs", "runs", "runs"]],
  ["a command that may write", fakeRequest.shell("rm -rf build"), ["command", "command", "runs", "runs"]],
  ["a file change", fakeRequest.write("/home/bot/workspace/README.md"), ["file-change", "runs", "runs", "runs"]],
  ["a connection read", fakeRequest.readOnlyShell("acli jira workitem view CHIEF-1"), ["command", "runs", "runs", "runs"]],
  ["a connection write", fakeRequest.shell("acli jira workitem delete --key CHIEF-1"), ["connector", "connector", "connector", "runs"]],
  ["a GitHub tool that writes", fakeRequest.mcp("github", "Merge pull request", false), ["tool", "tool", "tool", "runs"]],
  ["a GitHub tool that reads", fakeRequest.mcp("github", "Get file contents", true), ["runs", "runs", "runs", "runs"]],
  ["one of the worker's own tools", fakeRequest.tool("create_pull_request", {}), ["runs", "runs", "runs", "runs"]],
];

test.each(cases)("%s: what each access mode asks", (_name, request, expected) => {
  expect(AccessMode.options.map((access) => approvalFor(request, [jira], access)?.kind ?? "runs")).toEqual(expected);
});

test("a supervised command or file change shows the user exactly what runs", () => {
  expect(approvalFor(fakeRequest.readOnlyShell("cat notes.txt"), [], "supervised")).toEqual({ kind: "command", detail: "cat notes.txt" });
  expect(approvalFor(fakeRequest.write("/home/bot/workspace/a.ts"), [], "supervised")).toEqual({ kind: "file-change", detail: "/home/bot/workspace/a.ts" });
});
