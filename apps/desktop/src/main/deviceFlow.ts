import { z } from "zod";
import type { GitHubTokens } from "@chiefbot/contracts";

// GitHub's device flow for the deployer's GitHub App (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token).
// Runs in Electron main. It needs no client secret, and the app issues expiring
// tokens, so the token response carries a refresh token. The token gets the app's
// permissions on the repositories it is installed on: no scopes.

const DeviceCodeResponse = z.union([
  z.object({
    device_code: z.string(),
    user_code: z.string(),
    verification_uri: z.string(),
    interval: z.number(),
  }),
  z.object({ error: z.string() }),
]);

const TokenResponse = z.union([
  z.object({
    access_token: z.string(),
    expires_in: z.number(),
    refresh_token: z.string(),
    refresh_token_expires_in: z.number(),
  }),
  z.object({ error: z.string(), interval: z.number().optional() }),
]);

export type DeviceFlowOptions = {
  // https://github.com in production; a fake in tests.
  githubUrl: string;
  clientId: string;
  // Called once with the code the user types at the verification page.
  onCode: (code: { userCode: string; verificationUri: string }) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

// Resolves with the tokens once the user approves; rejects if they deny or the code expires.
export async function runDeviceFlow({
  githubUrl,
  clientId,
  onCode,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: DeviceFlowOptions): Promise<GitHubTokens> {
  const device = DeviceCodeResponse.parse(await postForm(`${githubUrl}/login/device/code`, { client_id: clientId }));
  if ("error" in device) {
    if (device.error === "device_flow_disabled") {
      throw new Error(
        "Your GitHub App has Device Flow off. Open its settings on github.com (`bun run setup` printed the link), tick Enable Device Flow and save.",
      );
    }
    throw new Error(`GitHub sign-in failed: ${device.error}`);
  }
  onCode({ userCode: device.user_code, verificationUri: device.verification_uri });

  let intervalSeconds = device.interval;
  for (;;) {
    await sleep(intervalSeconds * 1000);
    const res = TokenResponse.parse(
      await postForm(`${githubUrl}/login/oauth/access_token`, {
        client_id: clientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    );
    if ("access_token" in res) {
      const issuedAt = now();
      return {
        accessToken: res.access_token,
        accessTokenExpiresAt: issuedAt + res.expires_in * 1000,
        refreshToken: res.refresh_token,
        refreshTokenExpiresAt: issuedAt + res.refresh_token_expires_in * 1000,
      };
    }
    if (res.error === "authorization_pending") continue;
    if (res.error === "slow_down") {
      intervalSeconds = res.interval ?? intervalSeconds + 5;
      continue;
    }
    throw new Error(`GitHub sign-in failed: ${res.error}`);
  }
}

// GitHub answers OAuth errors as JSON { error }, some with a 4xx status.
const OAuthError = z.object({ error: z.string() });

async function postForm(url: string, form: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok && !OAuthError.safeParse(body).success) throw new Error(`GitHub ${new URL(url).pathname} failed: ${res.status}`);
  return body;
}
