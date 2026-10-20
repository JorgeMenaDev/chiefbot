import { mkdir, readdir, readFile, realpath, rm, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { RepoReadArgs, RepoSearchArgs } from "@chiefbot/contracts";
import type { Tool } from "@github/copilot-sdk";
import type { z } from "zod";

// The project's repo as its coordinator reads it: a copy of the default branch
// at a folder on the project's computer. At the start of each turn refreshCopy
// fetches the branch through control's git proxy with the turn's key (control
// lets a coordinator only fetch, and only its own project's repo) and checks it
// out. Nothing else writes to the folder, and control's scheduler runs one turn
// of the project at a time.

// What one turn reads: the copy at `root`, checked out at `commit`, or why it
// could not be refreshed. A failed refresh removes the copy, so no turn reads a
// stale one (its member may have lost access) and the next one starts clean.
export type RepoCopy = { root: string; commit: string } | { error: string };

// Git with no user or system config and no prompts, so nothing on the computer leaks in.
const isolatedGit = { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

// Runs git in `cwd` and resolves with its stdout, or throws with its stderr.
async function git(cwd: string, args: string[], env: Record<string, string> = { ...isolatedGit, HOME: cwd }) {
  const proc = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (exitCode !== 0) throw Object.assign(new Error(stderr.trim() || `git ${args[0]} failed`), { exitCode });
  return stdout;
}

// Fetches the default branch (the remote's HEAD) of the repo at `url` into the
// copy at `root` and checks it out, sending `turnKey` as the Basic auth password
// control's git proxy takes. The key goes in git's environment only, never in
// the copy's config.
export async function refreshCopy(root: string, url: string, turnKey: string): Promise<RepoCopy> {
  const env = {
    ...isolatedGit,
    HOME: root,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${turnKey}`)}`,
  };
  try {
    await mkdir(root, { recursive: true });
    await git(root, ["init", "-q"], env);
    await git(root, ["fetch", "-q", "--depth=1", "--no-tags", url, "HEAD"], env);
    await git(root, ["checkout", "-q", "--force", "--detach", "FETCH_HEAD"], env);
    await removeEscapingLinks(root);
    return { root, commit: (await git(root, ["rev-parse", "HEAD"], env)).trim() };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// Removes each symlink of the commit that leads outside the copy (or nowhere),
// so nothing that reads the copy follows one out: not the repo tools, and not
// the runtime, which reads skill folders itself.
async function removeEscapingLinks(root: string) {
  for (const entry of (await git(root, ["ls-files", "-s", "-z"])).split("\0")) {
    const [info = "", path = ""] = entry.split("\t");
    if (info.startsWith("120000 ") && "refused" in (await locate(root, path))) await unlink(join(root, path));
  }
}

// Where `path` (relative to the copy's root) leads, every symlink on the way
// followed: its real path and its path in the repo, or why it may not be read.
// Only the copy's own files and folders may be read, never its .git.
export async function locate(root: string, path: string): Promise<{ real: string; inRepo: string } | { refused: string }> {
  const realRoot = await realpath(root);
  const inRepo = (candidate: string) => {
    const rel = relative(realRoot, candidate);
    const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep)[0] === ".git";
    return outside ? null : rel;
  };
  const asked = resolve(realRoot, path);
  const real = await realpath(asked).catch(() => null);
  const rel = real === null ? null : inRepo(real);
  if (real !== null && rel !== null) return { real, inRepo: rel };
  if (inRepo(asked) === null) return { refused: `${path} is outside the repo.` };
  return { refused: real === null ? `The repo has no ${path}.` : `${path} leads outside the repo.` };
}

// How much one call returns, so a huge file or search cannot flood the model's context.
const READ_LINES = 500;
const LINE_CHARS = 2_000;
const LISTED_ENTRIES = 1_000;
const SEARCH_MATCHES = 200;
const MATCH_CHARS = 300;

const cut = (line: string, chars: number) => (line.length > chars ? `${line.slice(0, chars)}…` : line);

// repo_read: a folder's entries (folders end in /), or a file's lines from
// `startLine`, numbered, at most READ_LINES of them.
async function read(root: string, { path, startLine }: z.infer<typeof RepoReadArgs>) {
  const found = await locate(root, path);
  if ("refused" in found) throw new Error(found.refused);
  if ((await stat(found.real)).isDirectory()) {
    const entries = (await readdir(found.real, { withFileTypes: true }))
      .filter(({ name }) => !(found.inRepo === "" && name === ".git"))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    const more = entries.length > LISTED_ENTRIES ? [`(${entries.length - LISTED_ENTRIES} more entries)`] : [];
    return entries.length === 0 ? "(an empty folder)" : [...entries.slice(0, LISTED_ENTRIES), ...more].join("\n");
  }
  const bytes = await readFile(found.real);
  if (bytes.subarray(0, 8000).includes(0)) return `${path} is a binary file of ${bytes.length} bytes.`;
  const lines = bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (startLine > lines.length) return `${path} has ${lines.length} lines.`;
  const shown = lines.slice(startLine - 1, startLine - 1 + READ_LINES).map((line, index) => `${startLine + index}: ${cut(line, LINE_CHARS)}`);
  const last = startLine - 1 + shown.length;
  const more = last < lines.length ? [`(lines ${startLine} to ${last} of ${lines.length}: read on with startLine ${last + 1})`] : [];
  return [...shown, ...more].join("\n");
}

// repo_search: the lines of the repo's text files that match `pattern`, as
// path:line:text, at most SEARCH_MATCHES of them. Git searches only the files
// of the commit, so nothing outside the copy.
async function search(root: string, { pattern, path, ignoreCase }: z.infer<typeof RepoSearchArgs>) {
  const found = await locate(root, path);
  if ("refused" in found) throw new Error(found.refused);
  const where = found.inRepo === "" ? "." : `:(literal)${found.inRepo}`;
  const output = await git(root, ["grep", "-n", "-I", "--no-color", "-E", ...(ignoreCase ? ["-i"] : []), "-e", pattern, "--", where]).catch(
    (error: Error & { exitCode?: number }) => {
      // Git grep exits 1 when nothing matches.
      if (error.exitCode === 1) return "";
      throw error;
    },
  );
  const matches = output.split("\n").filter((line) => line !== "");
  if (matches.length === 0) return "No matches.";
  const more = matches.length > SEARCH_MATCHES ? [`(the first ${SEARCH_MATCHES} of ${matches.length} matches: narrow the search)`] : [];
  return [...matches.slice(0, SEARCH_MATCHES).map((line) => cut(line, MATCH_CHARS)), ...more].join("\n");
}

// The repo's instructions every agent reads, before the project's own `instructions`.
const standardInstructions = ["AGENTS.md", ".github/copilot-instructions.md"];
// How much of one instruction file the coordinator is told; it reads on with repo_read.
const INSTRUCTION_CHARS = 20_000;

// What `path` in the copy is, if it is a file or folder of the repo.
async function entry(root: string, path: string) {
  const found = await locate(root, path);
  if ("refused" in found) return null;
  const info = await stat(found.real);
  return { real: found.real, file: info.isFile(), folder: info.isDirectory() };
}

// What the coordinator is told of the repo in this turn: that it can read it,
// and the repo's instructions (the standard files, then the project's
// `configured` ones, those the copy has); or why it cannot read it.
export async function repoInstructions(copy: RepoCopy, configured: string[]): Promise<string> {
  if ("error" in copy) return `You cannot read the repo this turn: its copy could not be fetched (${copy.error}). Say so when the member asks about the code.`;
  const files = await Promise.all(
    [...new Set([...standardInstructions, ...configured])].map(async (path) => {
      const found = await entry(copy.root, path);
      if (!found?.file) return [];
      const text = (await readFile(found.real, "utf8")).trimEnd();
      const shown = text.length > INSTRUCTION_CHARS ? `${text.slice(0, INSTRUCTION_CHARS)}\n(cut at ${INSTRUCTION_CHARS} characters: read on with repo_read)` : text;
      return [`## ${path}\n${shown}`];
    }),
  );
  return [
    `You can read the repo: a copy of its default branch at commit ${copy.commit}, fetched at the start of this turn. ` +
      "repo_read reads a file or lists a folder, and repo_search searches the text of its files. Answer questions about the code from it, " +
      "naming the files you found, rather than dispatching an engineer. You cannot change files or run commands: that is the job of the engineers you dispatch.",
    ...(files.flat().length > 0
      ? ["The repo's instructions follow. They are written for the agents that change its code: use them to plan the work and to brief engineers.", ...files.flat()]
      : []),
  ].join("\n\n");
}

// The project's skill folders that are in this turn's copy, for the runtime to load skills from.
export async function skillRoots(copy: RepoCopy, configured: string[]): Promise<string[]> {
  if ("error" in copy) return [];
  const found = await Promise.all(configured.map(async (path) => entry(copy.root, path)));
  return found.flatMap((folder) => (folder?.folder ? [folder.real] : []));
}

// The coordinator's repo tools over this turn's copy. With no copy they still
// exist, and say why the repo cannot be read.
export function repoTools(copy: RepoCopy) {
  const tool = <Args extends z.ZodObject>(name: string, description: string, parameters: Args, run: (root: string, args: z.infer<Args>) => Promise<string>) =>
    ({
      name,
      description,
      parameters,
      handler: async (args: unknown) => {
        if ("error" in copy) throw new Error(`The repo copy could not be refreshed this turn: ${copy.error}`);
        return run(copy.root, parameters.parse(args));
      },
    }) satisfies Tool<unknown>;

  return [
    tool("repo_read", "Read a file of the repo (its default branch), with numbered lines, or list a folder.", RepoReadArgs, read),
    tool("repo_search", "Search the text of the repo's files (its default branch) for a regular expression. Answers path:line:text.", RepoSearchArgs, search),
  ];
}
