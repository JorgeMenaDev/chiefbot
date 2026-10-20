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
  ["a file read", { kind: "read", path: "/home/bot/workspace/README.md", intention: "Read a file" }, ["runs", "runs", "runs", "runs"]],
  ["a URL fetch", { kind: "url", url: "https://example.com", intention: "Fetch a page" }, ["runs", "runs", "runs", "runs"]],
  ["create_pull_request, which control asks for", fakeRequest.tool("create_pull_request", {}), ["runs", "runs", "runs", "runs"]],
  ["a chief tool that reads", fakeRequest.tool("list_projects", {}), ["runs", "runs", "runs", "runs"]],
  ["a chief tool that hands work off", fakeRequest.tool("send_to_project", { brief: "Fix the login" }), ["tool", "tool", "runs", "runs"]],
  ["the computer tool, on the bot's own screen", fakeRequest.tool("computer", { actions: [{ kind: "screenshot" }] }), ["tool", "tool", "runs", "runs"]],
  ["a tool the worker does not know", fakeRequest.tool("deploy", {}), ["tool", "tool", "runs", "runs"]],
  ["a memory", { kind: "memory", action: "store", fact: "The owner prefers short replies" }, ["tool", "tool", "runs", "runs"]],
  ["a hook", { kind: "hook", toolName: "bash", hookMessage: "Confirm this command" }, ["tool", "tool", "runs", "runs"]],
  [
    "a workflow",
    { kind: "workflow", name: "review", description: "Review the branch", approvalKey: "review", canPersistApproval: false, operation: "run", phases: [] },
    ["tool", "tool", "runs", "runs"],
  ],
  ["an extension install", { kind: "extension-management", operation: "install", extensionName: "lint" }, ["tool", "tool", "runs", "runs"]],
  ["an extension's permissions", { kind: "extension-permission-access", extensionName: "lint", capabilities: ["shell"] }, ["tool", "tool", "runs", "runs"]],
  ["an extension's environment", { kind: "extension-env-access", extensionName: "lint", environmentVariables: ["HOME"] }, ["tool", "tool", "runs", "runs"]],
];

test.each(cases)("%s: what each access mode asks", (_name, request, expected) => {
  expect(AccessMode.options.map((access) => approvalFor(request, [jira], access)?.kind ?? "runs")).toEqual(expected);
});

test("a supervised command or file change shows the user exactly what runs", () => {
  expect(approvalFor(fakeRequest.readOnlyShell("cat notes.txt"), [], "supervised")).toEqual({ kind: "command", detail: "cat notes.txt" });
  expect(approvalFor(fakeRequest.write("/home/bot/workspace/a.ts"), [], "supervised")).toEqual({ kind: "file-change", detail: "/home/bot/workspace/a.ts" });
});

test("a supervised computer call shows the user its action list", () => {
  const actions = [{ kind: "click", at: { x: 10, y: 20 } }, { kind: "type", text: "hello" }];

  expect(approvalFor(fakeRequest.tool("computer", { actions }), [], "supervised")).toEqual({
    kind: "tool",
    detail: 'computer {"actions":[{"kind":"click","at":{"x":10,"y":20}},{"kind":"type","text":"hello"}]}',
  });
});
