import { createSign } from "node:crypto";
import { z } from "zod";
import type { CopilotPlan, GitHubTokens, OpenedPullRequest, PullRequestArgs } from "@chiefbot/contracts";

// Control's GitHub calls: the two reads it makes with a user's access token at
// sign-in, the refresh grant, and repo access: what a user may do on a repo, the
// deployer's GitHub App's installation tokens, and opening pull requests.

const GitHubUserResponse = z.object({ id: z.number().int(), login: z.string() });
const CopilotUserResponse = z.object({ copilot_plan: z.string(), access_type_sku: z.string() });

export type GitHubIdentity = { githubId: number; login: string; copilotPlan: CopilotPlan };

export class GitHubAuthError extends Error {}

// Who owns this access token, and which Copilot plan they have (null when GitHub
// says they have no Copilot). Throws GitHubAuthError when GitHub rejects the token.
export async function fetchIdentity(apiUrl: string, accessToken: string): Promise<GitHubIdentity> {
  const headers = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
  const [userRes, copilotRes] = await Promise.all([
    fetch(`${apiUrl}/user`, { headers }),
    fetch(`${apiUrl}/copilot_internal/user`, { headers }),
  ]);
  if (userRes.status === 401) throw new GitHubAuthError("GitHub rejected the access token");
  if (!userRes.ok) throw new Error(`GitHub /user failed: ${userRes.status}`);
  const user = GitHubUserResponse.parse(await userRes.json());

  let copilotPlan: CopilotPlan = null;
  if (copilotRes.ok) {
    const copilot = CopilotUserResponse.parse(await copilotRes.json());
    copilotPlan = { plan: copilot.copilot_plan, sku: copilot.access_type_sku };
  } else if (copilotRes.status !== 404) {
    throw new Error(`GitHub /copilot_internal/user failed: ${copilotRes.status}`);
  }
  return { githubId: user.id, login: user.login, copilotPlan };
}

const RefreshResponse = z.union([
  z.object({
    access_token: z.string().min(1),
    expires_in: z.number(),
    refresh_token: z.string().min(1),
    refresh_token_expires_in: z.number(),
  }),
  z.object({ error: z.string() }),
]);

// Trades a refresh token for a new pair; the old pair stops working. Tokens from
// the device flow need no client secret. Null when GitHub refuses the refresh
// token (expired, already used, or the user revoked the app); throws on any other failure.
export async function refreshGitHubTokens(githubUrl: string, clientId: string, refreshToken: string): Promise<GitHubTokens | null> {
  const res = await fetch(`${githubUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`GitHub refresh failed: ${res.status}`);
  const body = RefreshResponse.parse(await res.json());
  if ("error" in body) {
    if (body.error === "bad_refresh_token") return null;
    throw new Error(`GitHub refresh failed: ${body.error}`);
  }
  const issuedAt = Date.now();
  return {
    accessToken: body.access_token,
    accessTokenExpiresAt: issuedAt + body.expires_in * 1000,
    refreshToken: body.refresh_token,
    refreshTokenExpiresAt: issuedAt + body.refresh_token_expires_in * 1000,
  };
}

// What a user may do on a repo, per GitHub, with their own token: "none" when
// they cannot see it (404), else "read" or "write" (push).
export async function repoPermission(apiUrl: string, accessToken: string, fullName: string): Promise<"none" | "read" | "write"> {
  const res = await fetch(`${apiUrl}/repos/${fullName}`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json" } });
  if (res.status === 404 || res.status === 403) return "none";
  if (!res.ok) throw new Error(`GitHub /repos/${fullName} failed: ${res.status}`);
  const repo = z.object({ permissions: z.object({ push: z.boolean() }).optional() }).parse(await res.json());
  return repo.permissions?.push ? "write" : "read";
}

// The deployer's GitHub App (`bun run setup`): its ID and PEM private key.
export type GitHubAppKey = { id: number; privateKey: string };

// The access an installation token gets: read to fetch; write to push and open pull requests.
const installationPermissions = {
  read: { contents: "read" },
  write: { contents: "write", pull_requests: "write" },
};

// A one-hour installation token of the app for one repo, with only the
// permissions `access` needs. Null when the app is not installed on the repo.
export async function installationToken(
  apiUrl: string,
  app: GitHubAppKey,
  fullName: string,
  access: keyof typeof installationPermissions,
): Promise<string | null> {
  const headers = { authorization: `Bearer ${appJwt(app)}`, accept: "application/vnd.github+json" };
  const installation = await fetch(`${apiUrl}/repos/${fullName}/installation`, { headers });
  if (installation.status === 404) return null;
  if (!installation.ok) throw new Error(`GitHub /repos/${fullName}/installation failed: ${installation.status}`);
  const { id } = z.object({ id: z.number().int() }).parse(await installation.json());
  const res = await fetch(`${apiUrl}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({ repositories: [fullName.split("/")[1]], permissions: installationPermissions[access] }),
  });
  if (!res.ok) throw new Error(`GitHub refused an installation token for ${fullName}: ${res.status}`);
  return z.object({ token: z.string().min(1) }).parse(await res.json()).token;
}

// A JWT that authenticates as the app (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app):
// backdated a minute for clock drift, and valid for less than GitHub's ten-minute limit.
function appJwt({ id, privateKey }: GitHubAppKey) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: String(id) })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

// Opens a pull request; GitHub's refusal (e.g. 422, no such branch) comes back as `refused`.
export async function createPullRequest(
  apiUrl: string,
  token: string,
  { repository, head, base, title, body }: PullRequestArgs,
): Promise<OpenedPullRequest | { refused: string }> {
  const res = await fetch(`${apiUrl}/repos/${repository}/pulls`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    body: JSON.stringify({ head, base, title, body }),
  });
  if (!res.ok) return { refused: `GitHub refused the pull request (${res.status}): ${await res.text()}` };
  const pr = z.object({ number: z.number().int(), html_url: z.string() }).parse(await res.json());
  return { number: pr.number, url: pr.html_url };
}
