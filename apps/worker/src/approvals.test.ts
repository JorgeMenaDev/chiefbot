import { expect, test } from "bun:test";
import { approvalFor } from "./approvals.ts";
import { fakeRequest } from "./fakeCopilot.ts";

test("a GitHub tool that writes asks the user; one that only reads does not", () => {
  expect(approvalFor(fakeRequest.mcp("github", "Merge pull request", false))).toEqual({
    kind: "tool",
    detail: "github: Merge pull request",
  });
  expect(approvalFor(fakeRequest.mcp("github", "Get file contents", true))).toBeNull();
});
