import { z } from "zod";
import type { CopilotPlan } from "@chiefbot/contracts";

// The two GitHub reads control makes with a user's access token at sign-in.

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
