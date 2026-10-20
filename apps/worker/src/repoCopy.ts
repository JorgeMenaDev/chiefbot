import { mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { RepoReadArgs, RepoSearchArgs } from "@chiefbot/contracts";
import type { Tool } from "@github/copilot-sdk";
import type { z } from "zod";

// The project's repo as its coordinator reads it: a copy of the default branch
// in a folder on the project's computer. At the start of each turn refreshCopy
// fetches the branch through control's git proxy with the turn's key (control
// lets a coordinator only fetch, and only its own project's repo) and checks it
// out with symlinks as plain files, so the folder holds none to follow out. The
// repo tools and the instructions read the fetched commit's objects, never the
// folder, so what they answer is that commit whatever happens to the folder;
// only the runtime reads the folder, for skills. The coordinator runs one
// refresh at a time (coordinator.ts), so none changes the copy under another turn.

// What one turn reads: the copy at `root`, fetched at `commit`, or why it could
// not be refreshed. A failed refresh removes the copy, so no turn reads a stale
// one (its member may have lost access) and the next one starts clean.
export type RepoCopy = { root: string; commit: string } | { error: string };
type FetchedCopy = Extract<RepoCopy, { root: string }>;

// Git with no user or system config and no prompts, so nothing on the computer
// leaks in, and with pathspecs taken literally.
const isolatedGit = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LITERAL_PATHSPECS: "1",
};

// Settings no config of the copy's own .git can change: no hooks, no fsmonitor
// command, and no gc or maintenance left running in the background.
const fixedConfig = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];

// Runs git in `cwd` and resolves with its stdout, cut at `limit` bytes (git is
// stopped there, so a huge output never sits in memory); throws with its stderr
// when it fails. `signal` stops it too. Git runs in a process group of its own,
// so stopping it stops what it started (fetch's HTTP helper), and it resolves
// only once all of them exited: nothing then holds its stderr open.
async function git(cwd: string, args: string[], { env = { ...isolatedGit, HOME: cwd }, limit = Number.POSITIVE_INFINITY, signal }: { env?: Record<string, string>; limit?: number; signal?: AbortSignal | undefined } = {}) {
  const proc = Bun.spawn(["git", ...fixedConfig, ...args], { cwd, env, stdout: "pipe", stderr: "pipe", detached: true });
  const stop = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // The whole group has exited.
    }
  };
  signal?.addEventListener("abort", stop);
  try {
    if (signal?.aborted) stop();
    const stderr = new Response(proc.stderr).text();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let cut = false;
    for await (const chunk of proc.stdout) {
      if (size + chunk.length > limit) {
        chunks.push(chunk.subarray(0, limit - size));
        cut = true;
        stop();
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
    const [exitCode, errors] = await Promise.all([proc.exited, stderr]);
    if (signal?.aborted) throw new Error(`git ${args[0]} stopped`);
    if (exitCode !== 0 && !cut) throw Object.assign(new Error(errors.trim() || `git ${args[0]} failed`), { exitCode });
    return { out: Buffer.concat(chunks), cut };
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

// Fetches the default branch (the remote's HEAD) of the repo at `url` into the
// copy at `root` and checks it out, sending `turnKey` as the Basic auth password
// control's git proxy takes. The key goes in git's environment only, never in
// the copy's config. `signal` stops the refresh (its turn ended), which fails it.
export async function refreshCopy(root: string, url: string, turnKey: string, signal?: AbortSignal): Promise<RepoCopy> {
  const env = {
    ...isolatedGit,
    HOME: root,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${turnKey}`)}`,
    // A symlink checks out as a plain file holding its target.
    GIT_CONFIG_KEY_1: "core.symlinks",
    GIT_CONFIG_VALUE_1: "false",
  };
  try {
    await mkdir(root, { recursive: true });
    await git(root, ["init", "-q"], { env, signal });
    await git(root, ["fetch", "-q", "--depth=1", "--no-tags", url, "HEAD"], { env, signal });
    await git(root, ["checkout", "-q", "--force", "--detach", "FETCH_HEAD"], { env, signal });
    return { root, commit: (await git(root, ["rev-parse", "HEAD"], { env })).out.toString().trim() };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// Whether the runtime may read `path`: a file or folder of the copy's folder,
// not its .git. The folder holds no symlinks, and only refreshCopy writes it.
export async function readable(copy: RepoCopy, path: string) {
  if ("error" in copy) return false;
  const [realRoot, real] = await Promise.all([realpath(copy.root), realpath(path).catch(() => null)]);
  if (real === null) return false;
  const rel = relative(realRoot, real);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && rel.split(sep)[0] !== ".git";
}

// One entry of a commit's tree.
type Entry = { path: string; kind: "folder" | "file" | "link" | "submodule"; object: string; size: number };

// The entries `git ls-tree -z [--long]` lists. Each record is "<mode> <type>
// <object> [<size>]<tab><path>", and a path may hold anything but NUL, tabs too.
function entries(listing: string): Entry[] {
  return listing.split("\0").flatMap((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) return [];
    const [mode = "", type = "", object = "", size = ""] = record.slice(0, tab).split(/ +/);
    const kind = type === "tree" ? "folder" : type === "commit" ? "submodule" : mode === "120000" ? "link" : "file";
    return [{ path: record.slice(tab + 1), kind, object, size: Number(size) || 0 }];
  });
}

// `path` as a path in the repo ("" for its root), or null when it leads outside.
function inRepo(path: string) {
  if (posix.isAbsolute(path)) return null;
  const normal = posix.normalize(path === "" ? "." : path).replace(/\/+$/, "");
  if (normal === ".." || normal.startsWith("../")) return null;
  return normal === "." ? "" : normal;
}

// Links followed to find one entry: a longer chain leads nowhere.
const LINK_HOPS = 8;
// The longest link target read.
const LINK_BYTES = 4096;

// What `path` is in the copy's commit, symlinks to the repo's own files and
// folders followed: the entry and its path in the repo, or why it may not be read.
// The commit holds no .git, so its .git is not found.
async function find({ root, commit }: FetchedCopy, path: string): Promise<{ at: string; entry: Entry } | { refused: string }> {
  let at: string | null = inRepo(path);
  if (at === null) return { refused: `${path} is outside the repo.` };
  for (let hops = 0; hops <= LINK_HOPS; hops++) {
    if (at === "") return { at, entry: { path: "", kind: "folder", object: commit, size: 0 } };
    const name: string = at;
    const entry: Entry | undefined = entries((await git(root, ["ls-tree", "-z", "--long", commit, "--", name])).out.toString()).find(({ path }) => path === name);
    if (!entry) return { refused: `The repo has no ${path}.` };
    if (entry.kind !== "link") return { at, entry };
    const target: string = (await git(root, ["cat-file", "blob", entry.object], { limit: LINK_BYTES })).out.toString();
    at = posix.isAbsolute(target) ? null : inRepo(posix.join(posix.dirname(name), target));
    if (at === null) return { refused: `${path} leads outside the repo.` };
  }
  return { refused: `${path} leads outside the repo.` };
}

// How much one call reads and returns, so a huge file, folder or search can
// flood neither the model's context nor the coordinator's memory.
const READ_BYTES = 1 << 20;
const READ_LINES = 500;
const LINE_CHARS = 2_000;
const LIST_BYTES = 256 * 1024;
const LISTED_ENTRIES = 1_000;
const SEARCH_BYTES = 256 * 1024;
const SEARCH_MATCHES = 200;
const MATCH_CHARS = 300;

const cut = (line: string, chars: number) => (line.length > chars ? `${line.slice(0, chars)}…` : line);

// repo_read: a folder's entries (folders end in /), or a file's lines from
// `startLine`, numbered, at most READ_LINES of them, from its first READ_BYTES.
async function read(copy: FetchedCopy, { path, startLine }: z.infer<typeof RepoReadArgs>) {
  const found = await find(copy, path);
  if ("refused" in found) throw new Error(found.refused);
  const { entry } = found;
  if (entry.kind === "submodule") return `${path} is a submodule: its files are in another repo.`;
  if (entry.kind === "folder") {
    const listing = await git(copy.root, ["ls-tree", "-z", entry.object], { limit: LIST_BYTES });
    const listed = entries(listing.out.toString());
    // A cut listing ends in part of an entry.
    if (listing.cut) listed.pop();
    const names = listed.map(({ path, kind }) => (kind === "folder" ? `${path}/` : path)).sort();
    const more = listing.cut || names.length > LISTED_ENTRIES ? ["(more entries than shown: name a folder inside, or search)"] : [];
    return names.length === 0 ? "(an empty folder)" : [...names.slice(0, LISTED_ENTRIES), ...more].join("\n");
  }
  const blob = await git(copy.root, ["cat-file", "blob", entry.object], { limit: READ_BYTES });
  if (blob.out.subarray(0, 8000).includes(0)) return `${path} is a binary file of ${entry.size} bytes.`;
  const lines = blob.out.toString("utf8").split("\n");
  // The last one is empty after the final newline, or cut short.
  if (blob.cut || lines.at(-1) === "") lines.pop();
  if (startLine > lines.length) {
    return blob.cut ? `${path} is ${entry.size} bytes: a read goes only as far as line ${lines.length}. Search it with repo_search.` : `${path} has ${lines.length} lines.`;
  }
  const shown = lines.slice(startLine - 1, startLine - 1 + READ_LINES).map((line, index) => `${startLine + index}: ${cut(line, LINE_CHARS)}`);
  const last = startLine - 1 + shown.length;
  const of = blob.cut ? `the first ${lines.length}, which is as far as a read goes` : `${lines.length}`;
  const more =
    last < lines.length
      ? [`(lines ${startLine} to ${last} of ${of}: read on with startLine ${last + 1})`]
      : blob.cut
        ? [`(line ${last} is as far as a read goes: search the rest with repo_search)`]
        : [];
  return [...shown, ...more].join("\n");
}

// repo_search: the lines of the commit's text files that match `pattern`, as
// path:line:text, at most SEARCH_MATCHES of them from SEARCH_BYTES of git's output.
async function search(copy: FetchedCopy, { pattern, path, ignoreCase }: z.infer<typeof RepoSearchArgs>) {
  const found = await find(copy, path);
  if ("refused" in found) throw new Error(found.refused);
  const args = ["grep", "-n", "-I", "--no-color", "-E", `--max-count=${SEARCH_MATCHES}`, ...(ignoreCase ? ["-i"] : []), "-e", pattern, copy.commit, "--", ...(found.at === "" ? [] : [found.at])];
  const output = await git(copy.root, args, { limit: SEARCH_BYTES }).catch((error: Error & { exitCode?: number }) => {
    // Git grep exits 1 when nothing matches.
    if (error.exitCode === 1) return { out: Buffer.alloc(0), cut: false };
    throw error;
  });
  // Each line starts "<commit>:".
  const matches = output.out
    .toString("utf8")
    .split("\n")
    .flatMap((line) => (line === "" ? [] : [line.slice(copy.commit.length + 1)]));
  // A cut output ends in part of a line: dropped, unless it is the only one.
  if (output.cut && matches.length > 1) matches.pop();
  if (matches.length === 0) return "No matches.";
  const shown = matches.slice(0, SEARCH_MATCHES).map((line) => cut(line, MATCH_CHARS));
  const more = output.cut || matches.length > SEARCH_MATCHES ? [`(the first ${shown.length} matches: narrow the search)`] : [];
  return [...shown, ...more].join("\n");
}

// The repo's instructions every agent reads, before the project's own `instructions`.
const standardInstructions = ["AGENTS.md", ".github/copilot-instructions.md"];
// How much of one instruction file the coordinator is told; it reads on with repo_read.
const INSTRUCTION_BYTES = 20_000;

// What a turn takes from the repo besides its tools: what the coordinator is
// told of it (that it can read it, the repo's instructions: the standard files,
// then the project's `instructions`), the `skills` folders the runtime loads
// skills from, and the configured paths skipped, each with why. A path is
// looked up in the commit, where a folder that is a symlink holds nothing, so a
// path through one is not found. Or, with no copy, why it cannot read the repo.
export async function repoSetup(copy: RepoCopy, config: { instructions: string[]; skills: string[] }) {
  if ("error" in copy) {
    const instructions = `You cannot read the repo this turn: its copy could not be fetched (${copy.error}). Say so when the member asks about the code.`;
    return { instructions, skillDirectories: [], skipped: [] };
  }
  const at = copy.commit.slice(0, 7);
  const skip = (what: "instructions" | "skills", path: string, found: Awaited<ReturnType<typeof find>>) =>
    "refused" in found
      ? `${what} path ${path} not found in the repo at ${at}; use the real path, not a symlink`
      : `${what} path ${path} is a ${found.entry.kind} in the repo at ${at}, not a ${what === "skills" ? "folder" : "file"}`;
  const files: string[] = [];
  const skipped: string[] = [];
  for (const path of new Set([...standardInstructions, ...config.instructions])) {
    const found = await find(copy, path);
    if ("at" in found && found.entry.kind === "file") {
      const { out, cut } = await git(copy.root, ["cat-file", "blob", found.entry.object], { limit: INSTRUCTION_BYTES });
      const text = out.toString("utf8").trimEnd();
      files.push(`## ${path}\n${cut ? `${text}\n(cut at ${INSTRUCTION_BYTES} bytes: read on with repo_read)` : text}`);
    } else if (config.instructions.includes(path)) {
      skipped.push(skip("instructions", path, found));
    }
  }
  const skillDirectories: string[] = [];
  for (const path of config.skills) {
    const found = await find(copy, path);
    if ("at" in found && found.entry.kind === "folder") skillDirectories.push(join(copy.root, found.at));
    else skipped.push(skip("skills", path, found));
  }
  const instructions = [
    `You can read the repo: a copy of its default branch at commit ${copy.commit}, fetched at the start of this turn. ` +
      "repo_read reads a file or lists a folder, and repo_search searches the text of its files. Answer questions about the code from it, " +
      "naming the files you found, rather than dispatching an engineer. You cannot change files or run commands: that is the job of the engineers you dispatch.",
    ...(files.length > 0 ? ["The repo's instructions follow. They are written for the agents that change its code: use them to plan the work and to brief engineers.", ...files] : []),
    ...(skipped.length > 0 ? [["These configured paths were skipped:", ...skipped.map((line) => `- ${line}`)].join("\n")] : []),
  ].join("\n\n");
  return { instructions, skillDirectories, skipped };
}

// The coordinator's repo tools over this turn's copy. With no copy they still
// exist, and say why the repo cannot be read.
export function repoTools(copy: RepoCopy) {
  const tool = <Args extends z.ZodObject>(name: string, description: string, parameters: Args, run: (copy: FetchedCopy, args: z.infer<Args>) => Promise<string>) =>
    ({
      name,
      description,
      parameters,
      handler: async (args: unknown) => {
        if ("error" in copy) throw new Error(`The repo copy could not be refreshed this turn: ${copy.error}`);
        return run(copy, parameters.parse(args));
      },
    }) satisfies Tool<unknown>;

  return [
    tool("repo_read", "Read a file of the repo (its default branch), with numbered lines, or list a folder.", RepoReadArgs, read),
    tool("repo_search", "Search the text of the repo's files (its default branch) for a regular expression. Answers path:line:text.", RepoSearchArgs, search),
  ];
}
