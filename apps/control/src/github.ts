import { z } from "zod";
import type { CopilotPlan, GitHubTokens } from "@chiefbot/contracts";

// Control's GitHub calls: the two reads it makes with a user's access token at
// sign-in, and the refresh grant.

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
