import { expect, test } from "bun:test";
import { GitRef } from "./repos.ts";

test("a branch or tag follows git's ref-name rules, and never starts with a dash", () => {
  const accepted = ["main", "v1.2", "fix/login", "release+fix", "rélease", "feature/a.b", "a-b_c"];
  const refused = [
    "main/",
    "main//child",
    "/main",
    "release.lock",
    "fix/release.lock/x",
    "release.",
    ".hidden",
    "fix/.hidden",
    "a..b",
    "-main",
    "a b",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[b",
    "a\\b",
    "a\u0007",
    "@",
    "a@{1}",
    "",
  ];

  expect(accepted.filter((ref) => !GitRef.safeParse(ref).success)).toEqual([]);
  expect(refused.filter((ref) => GitRef.safeParse(ref).success)).toEqual([]);
});
