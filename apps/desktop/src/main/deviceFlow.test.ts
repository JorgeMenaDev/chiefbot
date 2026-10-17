import { afterEach, expect, test } from "bun:test";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { runDeviceFlow } from "./deviceFlow.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

test("device flow shows the code, waits through pending and slow_down, then returns the tokens", async () => {
  const github = startFakeGitHub({ pollErrors: ["authorization_pending", "slow_down"] });
  stops.push(github.stop);
  const codes: string[] = [];
  const sleeps: number[] = [];

  const tokens = await runDeviceFlow({
    githubUrl: github.url,
    clientId: "test-client",
    onCode: ({ userCode }) => codes.push(userCode),
    sleep: async (ms) => void sleeps.push(ms),
    now: () => 1_000,
  });

  expect(codes).toEqual(["ABCD-1234"]);
  expect(sleeps).toEqual([5_000, 5_000, 10_000]);
  expect(tokens).toEqual({
    accessToken: "gho_fake_1",
    accessTokenExpiresAt: 1_000 + 28_800_000,
    refreshToken: "ghr_fake_1",
    refreshTokenExpiresAt: 1_000 + 15_897_600_000,
  });
  expect(github.tokenRequests.at(-1)).toMatchObject({
    client_id: "test-client",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
});

test("device flow fails when the user denies access", async () => {
  const github = startFakeGitHub({ pollErrors: ["access_denied"] });
  stops.push(github.stop);

  const run = runDeviceFlow({
    githubUrl: github.url,
    clientId: "test-client",
    onCode: () => {},
    sleep: async () => {},
  });

  await expect(run).rejects.toThrow("access_denied");
});

test("device flow names the setting to turn on when the GitHub App has Device Flow off", async () => {
  const github = startFakeGitHub({ deviceFlowDisabled: true });
  stops.push(github.stop);

  const run = runDeviceFlow({ githubUrl: github.url, clientId: "test-client", onCode: () => {}, sleep: async () => {} });

  await expect(run).rejects.toThrow(/Enable Device Flow/);
});
