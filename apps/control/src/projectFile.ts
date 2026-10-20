import { ProjectFile, projectFileName, type ProjectFileState } from "@chiefbot/contracts";
import type { z } from "zod";
import { textWithin } from "./http.ts";

// The most of a project file control reads.
const FILE_LIMIT = 64 * 1024;
// The longest error control keeps of a project file or settings, so a stored or shown one stays short.
const ERROR_LIMIT = 900;

// Reads and checks a repo's chiefbot.project.yaml through the GitHub API with
// a read token from control's repo access (repos.ts): the repo app's
// installation token once the asking user may read the repo, or none for a
// public repo the app is not installed on. Not the user's own token: it comes
// from the sign-in app, which sees no private repo.
// Resolves with what is there (no file, or an invalid one, is a state, not a
// refusal), or with why the repo cannot be read: GitHub answers 404 for a
// missing file and for a repo the token cannot see, so a 404 asks for the repo too.
export async function readProjectFile(
  githubApiUrl: string,
  token: string | null,
  repo: string,
): Promise<ProjectFileState | { refusal: { error: "repo_not_found" | "github_failed"; status: number; message: string } }> {
  const get = (path: string, accept: string) =>
    fetch(`${githubApiUrl}/repos/${repo}${path}`, { headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), accept } });
  const res = await get(`/contents/${projectFileName}`, "application/vnd.github.raw+json");
  if (res.status === 404) {
    const found = await get("", "application/vnd.github+json");
    if (found.ok) return { status: "missing" };
    return { refusal: { error: "repo_not_found", status: 404, message: `${repo} was not found, or your GitHub account cannot see it.` } };
  }
  if (!res.ok) return { refusal: { error: "github_failed", status: 502, message: `GitHub answered ${res.status} when control read ${projectFileName} from ${repo}.` } };
  const text = await textWithin(res, FILE_LIMIT);
  if (text === null) return { status: "invalid", error: `${projectFileName}: larger than ${FILE_LIMIT / 1024} KB` };
  const file = parseProjectFile(text);
  return "error" in file ? { status: "invalid", error: `${projectFileName}: ${file.error}` } : { status: "found", file };
}

// The project file's keys from YAML text: a committed file, or a project's
// settings. An empty text sets no key. The error says what is wrong and where.
export function parseProjectFile(text: string): ProjectFile | { error: string } {
  let yaml: unknown;
  try {
    yaml = Bun.YAML.parse(text) ?? {};
  } catch (error) {
    return { error: shortened(`not valid YAML: ${error instanceof Error ? error.message : String(error)}`) };
  }
  const file = ProjectFile.safeParse(yaml);
  return file.success ? file.data : { error: issuesOf(file.error) };
}

// What is wrong, issue by issue with where, in at most ERROR_LIMIT characters.
export function issuesOf(error: z.ZodError) {
  return shortened(error.issues.map(({ path, message }) => (path.length > 0 ? `${path.join(".")}: ${message}` : message)).join("; "));
}

const shortened = (text: string) => (text.length > ERROR_LIMIT ? `${text.slice(0, ERROR_LIMIT - 1)}…` : text);
