import { expect, test } from "bun:test";
import { ContextImagePath, ContextPath } from "@chiefbot/contracts";
import { imagePathIn } from "./ProjectContext.tsx";

test("a context file's image is a PNG beside it in the context, never one outside it or on the web", () => {
  const from = ContextPath.parse("verify/task-1.md");

  expect(imagePathIn(from, "task-1-1.png")).toBe(ContextImagePath.parse("verify/task-1-1.png"));
  expect(imagePathIn(from, "../secret.png")).toBeNull();
  expect(imagePathIn(from, "https://tracker.example/pixel.png")).toBeNull();
});
