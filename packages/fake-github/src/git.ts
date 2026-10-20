import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Real git repositories behind the fake GitHub, served over smart HTTP by
// `git http-backend` (it ships with git). Each repo is a bare repo at
// <root>/<owner>/<name>.git, so the fake serves it at /<owner>/<name>.git.

// Git with no user or system config, so a developer's settings never leak in.
const isolated = { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

// Runs git and returns its trimmed stdout; throws with stderr on failure.
export function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: isolated });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

// Makes <root>/<fullName>.git with one commit on main holding `files`, by path (folders made as needed).
export function createBareRepo(root: string, fullName: string, files: Record<string, string>) {
  const work = mkdtempSync(join(tmpdir(), "fake-github-seed-"));
  try {
    git(work, ["init", "-q", "-b", "main"]);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    git(work, ["add", "."]);
    git(work, ["-c", "user.name=Octo", "-c", "user.email=octo@example.com", "commit", "-q", "-m", "Initial commit"]);
    const bare = join(root, `${fullName}.git`);
    git(dirname(work), ["clone", "-q", "--bare", work, bare]);
    return bare;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Answers one smart-HTTP request (clone, fetch or push) with git http-backend, a CGI program.
export async function gitHttpBackend(req: Request, root: string) {
  const url = new URL(req.url);
  const body = new Uint8Array(await req.arrayBuffer());
  const proc = Bun.spawn(["git", "http-backend"], {
    env: {
      ...isolated,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      // An authenticated user turns on push (receive-pack).
      REMOTE_USER: "x-access-token",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers.get("content-type") ?? "",
      CONTENT_LENGTH: String(body.byteLength),
      HTTP_CONTENT_ENCODING: req.headers.get("content-encoding") ?? "",
      GIT_PROTOCOL: req.headers.get("git-protocol") ?? "",
    },
    stdin: body,
    stdout: "pipe",
  });
  const output = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  // CGI output: header lines, a blank line, then the body.
  const text = new TextDecoder("latin1").decode(output);
  const crlf = text.indexOf("\r\n\r\n");
  const [split, gap] = crlf === -1 ? [text.indexOf("\n\n"), 2] : [crlf, 4];
  const headers = new Headers();
  let status = 200;
  for (const line of text.slice(0, split).split(/\r?\n/)) {
    const colon = line.indexOf(":");
    const [name, value] = [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers.set(name, value);
  }
  return new Response(output.slice(split + gap), { status, headers });
}
