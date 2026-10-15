import { afterEach, expect, test } from "bun:test";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControl } from "./control.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function setup() {
  const github = startFakeGitHub();
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url });
  stops.push(github.stop, control.stop);
  return { github, control };
}

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
  const { github, control } = setup();
  const tokens = tokensFrom(github);

  const res = await signIn(control.url, tokens);
  const text = await res.text();

  expect(res.status).toBe(200);
  const body = JSON.parse(text);
  expect(body.user.login).toBe("octo-jorge");
  expect(body.user.copilotPlan).toEqual({ plan: "individual", sku: "free_limited_copilot" });
  expect(typeof body.sessionToken).toBe("string");
  expect(text).not.toContain(tokens.refreshToken);
  expect(text).not.toContain(tokens.accessToken);
});

test("a session reads its user until it signs out", async () => {
  const { github, control } = setup();
  const { sessionToken } = await (await signIn(control.url, tokensFrom(github))).json();
  const auth = { authorization: `Bearer ${sessionToken}` };

  const me = await fetch(`${control.url}/me`, { headers: auth });
  expect(me.status).toBe(200);
  expect((await me.json()).login).toBe("octo-jorge");

  const signOut = await fetch(`${control.url}/sessions/current`, { method: "DELETE", headers: auth });
  expect(signOut.status).toBe(204);
  expect((await fetch(`${control.url}/me`, { headers: auth })).status).toBe(401);
});

test("sign-in with a token GitHub rejects opens no session", async () => {
  const { control } = setup();
  const now = Date.now();

  const res = await signIn(control.url, {
    accessToken: "gho_not_real",
    accessTokenExpiresAt: now,
    refreshToken: "ghr_not_real",
    refreshTokenExpiresAt: now,
  });

  expect(res.status).toBe(401);
});

test("one GitHub account stays one user across sign-ins and a control restart", async () => {
  const github = startFakeGitHub();
  stops.push(github.stop);
  const dbPath = join(mkdtempSync(join(tmpdir(), "chiefbot-control-")), "control.sqlite");

  const first = startControl({ port: 0, dbPath, githubApiUrl: github.url });
  const a = await (await signIn(first.url, tokensFrom(github))).json();
  first.stop();

  const second = startControl({ port: 0, dbPath, githubApiUrl: github.url });
  stops.push(second.stop);
  const me = await fetch(`${second.url}/me`, { headers: { authorization: `Bearer ${a.sessionToken}` } });
  const b = await (await signIn(second.url, tokensFrom(github))).json();

  expect((await me.json()).id).toBe(a.user.id);
  expect(b.user.id).toBe(a.user.id);
  expect(b.sessionToken).not.toBe(a.sessionToken);
});
