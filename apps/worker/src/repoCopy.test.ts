import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { refreshCopy, repoInstructions, repoTools, type RepoCopy } from "./repoCopy.ts";

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
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    symlinkSync(target, join(repo, path));
  }
  git("add", ".");
  git("-c", "user.name=Octo", "-c", "user.email=octo@example.com", "commit", "-q", "-m", "Seed");
  return repo;
}

// Each call's answer, or its refusal.
const run = (tool: ReturnType<typeof repoTools>[number], args: Record<string, string | number>) =>
  Promise.resolve(tool.handler(args)).then(String, (error: Error) => `refused: ${error.message}`);

// The copy of `repo` fetched into a new folder, with its read and search tools.
async function fetched(repo: string) {
  const computer = newFolder();
  const copy = await refreshCopy(join(computer, "repo"), repo, "turn-key");
  if (!("root" in copy)) throw new Error(copy.error);
  const [read, search] = repoTools(copy);
  if (!read || !search) throw new Error("no repo tools");
  return { computer, copy, read, search };
}

test("the repo tools read only the repo: a path outside it, its .git and a symlink that leads out are refused, and an in-repo symlink works", async () => {
  const elsewhere = newFolder();
  writeFileSync(join(elsewhere, "history.jsonl"), "another member's chat");
  const repo = repoWith({ "AGENTS.md": "# Agents\n", "src/app.ts": "export const app = 1;\n" }, { "CLAUDE.md": "AGENTS.md", leak: join(elsewhere, "history.jsonl"), up: "../history.jsonl" });
  const { read, search } = await fetched(repo);

  expect(await run(read, { path: "CLAUDE.md" })).toBe("1: # Agents");
  expect(await run(read, { path: "" })).toBe(["AGENTS.md", "CLAUDE.md", "leak", "src/", "up"].join("\n"));
  expect(await run(read, { path: "../history.jsonl" })).toBe("refused: ../history.jsonl is outside the repo.");
  expect(await run(read, { path: join(elsewhere, "history.jsonl") })).toBe(`refused: ${join(elsewhere, "history.jsonl")} is outside the repo.`);
  expect(await run(read, { path: ".git/config" })).toBe("refused: The repo has no .git/config.");
  expect(await run(read, { path: "leak" })).toBe("refused: leak leads outside the repo.");
  expect(await run(read, { path: "up" })).toBe("refused: up leads outside the repo.");
  expect(await run(search, { pattern: "member's" })).toBe("No matches.");
  expect(await run(search, { pattern: "app", path: "../" })).toBe("refused: ../ is outside the repo.");
  expect(await run(search, { pattern: "app", path: "src" })).toBe("src/app.ts:1:export const app = 1;");
});

test("the repo tools read the fetched commit, not the folder: a folder swapped for a symlink out of the copy changes nothing they answer", async () => {
  // Another member's files beside the copy on the project's computer.
  const repo = repoWith({ "src/app.ts": "export const app = 1;\n" });
  const { computer, copy, read, search } = await fetched(repo);
  mkdirSync(join(computer, "private"));
  writeFileSync(join(computer, "private", "app.ts"), "PRIVATE_OTHER_MEMBER\n");
  writeFileSync(join(computer, "private", "session.jsonl"), "OTHER_MEMBER_PRIVATE_CHAT\n");
  rmSync(join(copy.root, "src"), { recursive: true });
  symlinkSync(join(computer, "private"), join(copy.root, "src"));

  expect(await run(read, { path: "src/app.ts" })).toBe("1: export const app = 1;");
  expect(await run(read, { path: "src" })).toBe("app.ts");
  expect(await run(search, { pattern: "OTHER_MEMBER" })).toBe("No matches.");
  expect(await run(search, { pattern: "app" })).toBe("src/app.ts:1:export const app = 1;");
});

test("the copy on disk holds no symlinks, not even one named with a tab, so nothing that reads its folders follows one out", async () => {
  const elsewhere = newFolder();
  const repo = repoWith(
    { safe: "fine\n", ".agents/skills/release/SKILL.md": "Tag it.\n" },
    { "safe\tlink": join(elsewhere, "secret"), ".agents/skills/release/notes": join(elsewhere, "notes"), "CLAUDE.md": "safe" },
  );
  const { copy, read } = await fetched(repo);
  const links = (folder: string): string[] =>
    readdirSync(folder).flatMap((name) => {
      const path = join(folder, name);
      if (name === ".git") return [];
      const info = lstatSync(path);
      return info.isSymbolicLink() ? [path] : info.isDirectory() ? links(path) : [];
    });

  expect(links(copy.root)).toEqual([]);
  expect(await run(read, { path: "safe\tlink" })).toBe("refused: safe\tlink leads outside the repo.");
  expect(await run(read, { path: "CLAUDE.md" })).toBe("1: fine");
});

test("a read, a search and the instructions return at most their budget, however big the repo's files", async () => {
  const lines = (count: number, text: string) => Array.from({ length: count }, (_, index) => `${text} ${index + 1}`).join("\n") + "\n";
  const repo = repoWith({
    // About 1.9 MB, more than a read takes.
    "big.txt": lines(60_000, "a line of the big file, long enough to fill it"),
    "a.txt": lines(150, "match"),
    "b.txt": lines(150, "match"),
    "AGENTS.md": "x".repeat(50_000),
  });
  const { copy, read, search } = await fetched(repo);

  const first = await run(read, { path: "big.txt" });
  const beyond = await run(read, { path: "big.txt", startLine: 59_000 });
  const found = await run(search, { pattern: "^match" });
  const told = await repoInstructions(copy as RepoCopy, []);

  expect(first.split("\n").slice(0, 2)).toEqual(["1: a line of the big file, long enough to fill it 1", "2: a line of the big file, long enough to fill it 2"]);
  expect(first.split("\n").at(-1)).toMatch(/^\(lines 1 to 500 of the first \d+, which is as far as a read goes: read on with startLine 501\)$/);
  expect(beyond).toMatch(/^big\.txt is \d+ bytes: a read goes only as far as line \d+\. Search it with repo_search\.$/);
  expect(found.split("\n")).toHaveLength(201);
  expect(found.split("\n").at(-1)).toBe("(the first 200 matches: narrow the search)");
  expect(told).toContain(`## AGENTS.md\n${"x".repeat(20_000)}\n(cut at 20000 bytes: read on with repo_read)`);
  expect(told).not.toContain("x".repeat(20_001));
});
