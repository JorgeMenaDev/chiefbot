import { afterEach, expect, test } from "bun:test";
import type { startFakeGitHub } from "@chiefbot/fake-github";
import { SignInResponse, User } from "@chiefbot/contracts";
import { cleanUp, startTestControl } from "./testControl.ts";

afterEach(cleanUp);

function tokensFrom(github: ReturnType<typeof startFakeGitHub>) {
  const { accessToken, refreshToken } = github.issueTokens();
  const now = Date.now();
  return {
    accessToken,
    accessTokenExpiresAt: now + 8 * 3600_000,
    refreshToken,
    refreshTokenExpiresAt: now + 180 * 86400_000,
  };
}

function signIn(controlUrl: string, body: unknown) {
  return fetch(`${controlUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("sign-in answers with the GitHub login and Copilot plan, never the refresh token", async () => {
  const { github, url } = await startTestControl();
  const tokens = tokensFrom(github);

  const res = await signIn(url, tokens);
  const text = await res.text();

  expect(res.status).toBe(200);
  const body = SignInResponse.parse(JSON.parse(text));
  expect(body.user.login).toBe("octo-user");
  expect(body.user.copilotPlan).toEqual({ plan: "individual", sku: "free_limited_copilot" });
  expect(typeof body.sessionToken).toBe("string");
  expect(text).not.toContain(tokens.refreshToken);
  expect(text).not.toContain(tokens.accessToken);
});

test("a session reads its user until it signs out", async () => {
  const { github, url } = await startTestControl();
  const { sessionToken } = SignInResponse.parse(await (await signIn(url, tokensFrom(github))).json());
  const auth = { authorization: `Bearer ${sessionToken}` };

  const me = await fetch(`${url}/me`, { headers: auth });
  expect(me.status).toBe(200);
  expect(User.parse(await me.json()).login).toBe("octo-user");

  const signOut = await fetch(`${url}/sessions/current`, { method: "DELETE", headers: auth });
  expect(signOut.status).toBe(204);
  expect((await fetch(`${url}/me`, { headers: auth })).status).toBe(401);
});

test("sign-in with a token GitHub rejects opens no session", async () => {
  const { url } = await startTestControl();
  const now = Date.now();

  const res = await signIn(url, {
    accessToken: "gho_not_real",
    accessTokenExpiresAt: now,
    refreshToken: "ghr_not_real",
    refreshTokenExpiresAt: now,
  });

  expect(res.status).toBe(401);
});

test("one GitHub account stays one user across sign-ins and a control restart", async () => {
  const { github, url, restart } = await startTestControl({ persistent: true });

  const a = SignInResponse.parse(await (await signIn(url, tokensFrom(github))).json());
  restart();
  const me = await fetch(`${url}/me`, { headers: { authorization: `Bearer ${a.sessionToken}` } });
  const b = SignInResponse.parse(await (await signIn(url, tokensFrom(github))).json());

  expect(User.parse(await me.json()).id).toBe(a.user.id);
  expect(b.user.id).toBe(a.user.id);
  expect(b.sessionToken).not.toBe(a.sessionToken);
});
