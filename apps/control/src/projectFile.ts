import { ProjectFile, projectFileName } from "@chiefbot/contracts";

// Reads and checks a repo's chiefbot.project.yaml through the GitHub API with
// a read token from control's repo access (repos.ts): the repo app's
// installation token once the asking user may read the repo, or none for a
// public repo the app is not installed on. Not the user's own token: it comes
// from the sign-in app, which sees no private repo.
// Resolves with the file, or with an error that says what is wrong and where.
export async function readProjectFile(githubApiUrl: string, token: string | null, repo: string): Promise<ProjectFile | { error: string }> {
  const res = await fetch(`${githubApiUrl}/repos/${repo}/contents/${projectFileName}`, {
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), accept: "application/vnd.github.raw+json" },
  });
  if (res.status === 404) {
    return { error: `No ${projectFileName} at the root of ${repo}'s default branch, or your GitHub account cannot see ${repo}.` };
  }
  if (!res.ok) return { error: `GitHub answered ${res.status} when control read ${projectFileName} from ${repo}.` };
  return parseProjectFile(await res.text());
}

// An empty file is a project with no connectors or commands.
export function parseProjectFile(text: string): ProjectFile | { error: string } {
  let yaml: unknown;
  try {
    yaml = Bun.YAML.parse(text) ?? {};
  } catch (error) {
    return { error: `${projectFileName} is not valid YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
  const file = ProjectFile.safeParse(yaml);
  if (file.success) return file.data;
  const issues = file.error.issues.map(({ path, message }) => (path.length > 0 ? `${path.join(".")}: ${message}` : message));
  return { error: `${projectFileName} is not a valid project file. ${issues.join("; ")}` };
}
