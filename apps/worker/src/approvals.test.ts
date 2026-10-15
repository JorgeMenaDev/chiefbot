import { expect, test } from "bun:test";
import { approvalFor } from "./approvals.ts";
import { fakeRequest } from "./fakeCopilot.ts";

test("a push or a PR from the shell asks the user; other commands run without asking", () => {
  const ask = (command: string) => approvalFor(fakeRequest.shell(command));

  expect(ask("cd demo && git push -u origin fix-typo")).toEqual({
    kind: "command",
    detail: "cd demo && git push -u origin fix-typo",
  });
  expect(ask("git -C demo push --force")?.kind).toBe("command");
  expect(ask("gh pr create --fill")?.kind).toBe("command");
  expect(ask("gh pr merge 3")?.kind).toBe("command");
  expect(ask("gh repo delete octo/demo --yes")?.kind).toBe("command");
  expect(ask("git clone https://github.com/octo/demo && cd demo && git checkout -b fix")).toBeNull();
  expect(ask("git commit -am 'Fix typo'")).toBeNull();
  expect(ask("ls -la")).toBeNull();
});

test("opening a pull request with the tool asks the user, and the card says where it goes", () => {
  const request = fakeRequest.tool("create_pull_request", {
    repository: "octo/demo",
    head: "fix-typo",
    base: "main",
    title: "Fix a typo",
    body: "",
  });

  expect(approvalFor(request)).toEqual({ kind: "pull-request", detail: "octo/demo: fix-typo → main\nFix a typo" });
});

test("a GitHub tool that writes asks the user; one that only reads does not", () => {
  expect(approvalFor(fakeRequest.mcp("github", "Merge pull request", false))).toEqual({
    kind: "tool",
    detail: "github: Merge pull request",
  });
  expect(approvalFor(fakeRequest.mcp("github", "Get file contents", true))).toBeNull();
});

test("reading and editing files in the workspace runs without asking", () => {
  expect(approvalFor({ kind: "read", intention: "Read README", path: "/home/bot/workspace/README.md" })).toBeNull();
});
