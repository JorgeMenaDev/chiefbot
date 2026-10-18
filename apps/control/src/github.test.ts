import { afterEach, expect, test } from "bun:test";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { copilotRequestsToken } from "./github.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function github(options: Parameters<typeof startFakeGitHub>[0] = {}) {
  const fake = startFakeGitHub(options);
  stops.push(fake.stop);
  fake.createRepo("octo-org/shop", { "README.md": "# Shop" });
  return fake;
}

test("an organization's Copilot token is asked for one repository id and only Copilot Requests, so it cannot touch the repo", async () => {
  const fake = github({ copilotRequests: true });

  const minted = await copilotRequestsToken(fake.url, fake.app, "octo-org/shop");

  expect(minted).toEqual({ token: expect.stringMatching(/^ghs_/), expiresAt: expect.any(Number), account: "octo-org" });
  const asked = fake.installationTokenRequests.at(-1);
  expect(asked).toEqual({ repository_ids: [fake.repoId("octo-org/shop") ?? -1], permissions: { copilot_requests: "write" } });
  if ("error" in minted) throw new Error(minted.error);
  const read = await fetch(`${fake.url}/repos/octo-org/shop/contents/README.md`, { headers: { authorization: `Bearer ${minted.token}` } });
  expect(read.status).toBe(404);
});

test("without the Copilot Requests permission, or without the app on the repo's owner, the minter says what to fix", async () => {
  const withoutPermission = github();
  const refused = await copilotRequestsToken(withoutPermission.url, withoutPermission.app, "octo-org/shop");
  expect(refused).toEqual({ error: expect.stringContaining("Copilot Requests") });

  const notInstalled = github({ copilotRequests: true });
  notInstalled.createRepo("octo-org/elsewhere", { "README.md": "# Elsewhere" }, { installed: false });
  const missing = await copilotRequestsToken(notInstalled.url, notInstalled.app, "octo-org/elsewhere");
  expect(missing).toEqual({ error: expect.stringContaining("not installed on octo-org") });
});
