import { createSign } from "node:crypto";
import { z } from "zod";
import type { CopilotPlan, GitHubTokens, OpenedPullRequest, PullRequestArgs } from "@chiefbot/contracts";

// Control's GitHub calls: the two reads it makes with a user's access token at
// sign-in, the refresh grant (both for the sign-in app), and repo access through
// the deployer's repo app: its installation tokens, what a user may do on a repo
// as such a token reads it, and opening pull requests.

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

// What the user `login` may do on a repo, read with an installation token for it
// (https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user).
// The user's own token cannot tell: the sign-in app has no repository
// permissions, so it sees no private repo. GitHub's admin and write (maintain
// too) may push; read (triage too) may fetch.
export async function repoPermission(
  apiUrl: string,
  installationToken: string,
  fullName: string,
  login: string,
): Promise<"none" | "read" | "write"> {
  const res = await fetch(`${apiUrl}/repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`, {
    headers: { authorization: `Bearer ${installationToken}`, accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return "none";
  if (!res.ok) throw new Error(`GitHub /repos/${fullName}/collaborators/${login}/permission failed: ${res.status}`);
  const { permission } = z.object({ permission: z.string() }).parse(await res.json());
  return permission === "admin" || permission === "write" ? "write" : permission === "read" ? "read" : "none";
}

// The deployer's repo app (`bun run setup`): its ID and PEM private key.
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
  const installation = await installationOf(apiUrl, app, fullName);
  if (!installation) return null;
  const minted = await mint(apiUrl, app, installation.id, { repositories: [repoName(fullName)], permissions: installationPermissions[access] });
  if (!minted.ok) throw new Error(`GitHub refused an installation token for ${fullName}: ${minted.status}`);
  return minted.token;
}

// A one-hour installation token of the app that may only make Copilot requests
// (https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens).
// They bill `account`, the owner of the repo, where the app must be installed on
// all repositories. GitHub's Copilot check wants one repository id, so a first
// token, with only metadata, looks the repo's id up. The token cannot read or
// write the repo, so it may sit in a computer. Or what the deployer must fix.
export async function copilotRequestsToken(
  apiUrl: string,
  app: GitHubAppKey,
  fullName: string,
): Promise<{ token: string; expiresAt: number; account: string } | { error: string }> {
  const installation = await installationOf(apiUrl, app, fullName);
  if (!installation) {
    return { error: `Chiefbot's repo app is not installed on ${repoOwner(fullName)}, so it cannot pay for Copilot for ${fullName}.` };
  }
  const lookup = await mint(apiUrl, app, installation.id, { repositories: [repoName(fullName)], permissions: { metadata: "read" } });
  const repositoryId = lookup.ok ? lookup.repositories[0]?.id : undefined;
  if (repositoryId === undefined) return { error: `GitHub would not tell Chiefbot's repo app the id of ${fullName} (${lookup.status}).` };
  const minted = await mint(apiUrl, app, installation.id, { repository_ids: [repositoryId], permissions: { copilot_requests: "write" } });
  if (!minted.ok) {
    return {
      error: `GitHub refused a Copilot token for ${installation.account} (${minted.status}): Chiefbot's repo app needs the Copilot Requests permission, installed on all of ${installation.account}'s repositories (bun run setup --org-billed-copilot).`,
    };
  }
  return { token: minted.token, expiresAt: minted.expiresAt, account: installation.account };
}

const repoOwner = (fullName: string) => fullName.split("/")[0] ?? fullName;
const repoName = (fullName: string) => fullName.split("/")[1] ?? fullName;

// The app's installation on the repo's owner, or null when it is not installed on the repo.
async function installationOf(apiUrl: string, app: GitHubAppKey, fullName: string) {
  const res = await fetch(`${apiUrl}/repos/${fullName}/installation`, { headers: appHeaders(app) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub /repos/${fullName}/installation failed: ${res.status}`);
  const { id, account } = z.object({ id: z.number().int(), account: z.object({ login: z.string() }) }).parse(await res.json());
  return { id, account: account.login };
}

const MintedToken = z.object({
  token: z.string().min(1),
  expires_at: z.string(),
  repositories: z.array(z.object({ id: z.number().int() })).default([]),
});

// Mints an installation token; GitHub's refusal comes back with its status.
async function mint(
  apiUrl: string,
  app: GitHubAppKey,
  installationId: number,
  body: { repositories?: string[]; repository_ids?: number[]; permissions: Record<string, string> },
) {
  const res = await fetch(`${apiUrl}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: appHeaders(app),
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false as const, status: res.status };
  const minted = MintedToken.parse(await res.json());
  return { ok: true as const, status: res.status, token: minted.token, expiresAt: Date.parse(minted.expires_at), repositories: minted.repositories };
}

const appHeaders = (app: GitHubAppKey) => ({ authorization: `Bearer ${appJwt(app)}`, accept: "application/vnd.github+json" });

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
