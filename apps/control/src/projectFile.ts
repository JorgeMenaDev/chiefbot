import { ProjectFile, projectFileName } from "@chiefbot/contracts";

// Reads and checks a repo's chiefbot.project.yaml through the GitHub API with
// the asking user's access token (from the GitHub App they signed in with).
// Resolves with the file, or with an error that says what is wrong and where.
export async function readProjectFile(githubApiUrl: string, accessToken: string, repo: string): Promise<ProjectFile | { error: string }> {
  const res = await fetch(`${githubApiUrl}/repos/${repo}/contents/${projectFileName}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github.raw+json" },
  });
  if (res.status === 404) {
    return { error: `No ${projectFileName} at the root of ${repo}'s default branch, or your GitHub account cannot see ${repo}.` };
  }
  if (!res.ok) return { error: `GitHub answered ${res.status} when control read ${projectFileName} from ${repo}.` };
  return parseProjectFile(await res.text());
}

// An empty file is a project with no connectors, environments or commands.
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
