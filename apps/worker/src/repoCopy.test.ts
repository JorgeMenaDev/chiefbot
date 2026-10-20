import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { refreshCopy, repoTools } from "./repoCopy.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const newFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "chiefbot-copy-"));
  folders.push(folder);
  return folder;
};

// A repo with one commit holding `files` and the symlinks `links` (path → target), to fetch from.
function repoWith(files: Record<string, string>, links: Record<string, string> = {}) {
  const repo = newFolder();
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo, env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  for (const [path, target] of Object.entries(links)) symlinkSync(target, join(repo, path));
  git("add", ".");
  git("-c", "user.name=Octo", "-c", "user.email=octo@example.com", "commit", "-q", "-m", "Seed");
  return repo;
}

// Each call's answer, or its refusal.
const run = (tool: ReturnType<typeof repoTools>[number], args: Record<string, string>) =>
  Promise.resolve(tool.handler(args)).then(String, (error: Error) => `refused: ${error.message}`);

test("the repo tools read only the copy: a path outside it, its .git and a symlink that leads out are refused, and an in-repo symlink works", async () => {
  // Another member's session history, beside the copy on the project's computer.
  const computer = newFolder();
  writeFileSync(join(computer, "history.jsonl"), "another member's chat");
  const repo = repoWith({ "AGENTS.md": "# Agents\n", "src/app.ts": "export const app = 1;\n" }, { "CLAUDE.md": "AGENTS.md", leak: join(computer, "history.jsonl"), up: "../history.jsonl" });
  const root = join(computer, "repo");
  const copy = await refreshCopy(root, repo, "turn-key");
  // A symlink that appears in the copy later still leads nowhere.
  symlinkSync(join(computer, "history.jsonl"), join(root, "src", "planted"));
  const [read, search] = repoTools(copy);
  if (!read || !search) throw new Error("no repo tools");

  expect(await run(read, { path: "CLAUDE.md" })).toBe("1: # Agents");
  expect(await run(read, { path: "" })).toBe(["AGENTS.md", "CLAUDE.md", "src/"].join("\n"));
  expect(await run(read, { path: "../history.jsonl" })).toBe("refused: ../history.jsonl is outside the repo.");
  expect(await run(read, { path: join(computer, "history.jsonl") })).toBe(`refused: ${join(computer, "history.jsonl")} is outside the repo.`);
  expect(await run(read, { path: ".git/config" })).toBe("refused: .git/config is outside the repo.");
  expect(await run(read, { path: "leak" })).toBe("refused: The repo has no leak.");
  expect(await run(read, { path: "up" })).toBe("refused: The repo has no up.");
  expect(await run(read, { path: "src/planted" })).toBe("refused: src/planted leads outside the repo.");
  expect(await run(search, { pattern: "member's" })).toBe("No matches.");
  expect(await run(search, { pattern: "app", path: "../" })).toBe("refused: ../ is outside the repo.");
  expect(await run(search, { pattern: "app", path: "src" })).toBe("src/app.ts:1:export const app = 1;");
});
