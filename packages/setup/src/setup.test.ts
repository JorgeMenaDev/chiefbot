import { afterEach, expect, test } from "bun:test";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalConfig, writeLocalConfig } from "./config.ts";
import { nextSteps, runSetup } from "./setup.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function fixture() {
  const github = startFakeGitHub();
  const root = mkdtempSync(join(tmpdir(), "chiefbot-setup-"));
  stops.push(github.stop, () => rmSync(root, { recursive: true, force: true }));
  return { github, dir: join(root, ".chiefbot") };
}

// What the deployer's browser does: load setup's local page, which posts a
// manifest form to GitHub; GitHub (the fake) redirects back to setup's callback,
// whose page may post the next manifest. Clicks Create GitHub App on each one
// and returns the last page.
async function clickCreateGitHubApps(pageUrl: string) {
  const unescape = (html: string) =>
    html.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
  let page = await (await fetch(pageUrl)).text();
  for (;;) {
    const action = page.match(/<form[^>]* action="([^"]+)"/)?.[1];
    const manifest = page.match(/name="manifest" value="([^"]*)"/)?.[1];
    if (action === undefined || manifest === undefined) return page;
    page = await (await fetch(unescape(action), { method: "POST", body: new URLSearchParams({ manifest: unescape(manifest) }) })).text();
  }
}

const repoApp = { id: 1, slug: "chiefbot-old", clientId: "Iv-old", owner: "octo-user", htmlUrl: "https://github.com/apps/chiefbot-old" };

test("setup registers a repo app and a sign-in app with no repository permissions, and keeps them owner-only", async () => {
  const { github, dir } = fixture();
  let lastPage = "";

  const result = await runSetup({
    githubUrl: github.url,
    githubApiUrl: github.url,
    dir,
    open: async (url) => void (lastPage = await clickCreateGitHubApps(url)),
  });

  const [repoManifest, signInManifest] = github.manifests;
  expect(github.manifests).toHaveLength(2);
  for (const manifest of github.manifests) {
    expect(manifest.redirect_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(manifest.public).toBe(false);
  }
  expect(repoManifest?.default_permissions).toEqual({ contents: "write", pull_requests: "write" });
  expect(signInManifest?.default_permissions).toEqual({});

  const config = readLocalConfig(dir);
  const repoSlug = config?.githubApp.slug;
  const signInSlug = config?.signIn?.kind === "github-app" ? config.signIn.app.slug : "";
  expect(config).toEqual({
    githubApp: { id: 1000, slug: expect.stringMatching(/^chiefbot-/), clientId: "Iv-fake-client-1000", owner: "octo-user", htmlUrl: `${github.url}/apps/${repoSlug}` },
    signIn: {
      kind: "github-app",
      app: { id: 1001, slug: expect.stringMatching(/^chiefbot-sign-in-/), clientId: "Iv-fake-client-1001", owner: "octo-user", htmlUrl: `${github.url}/apps/${signInSlug}` },
    },
  });
  // Only the repo app's secrets: the device flow needs none, and nothing else uses the sign-in app's.
  expect(JSON.parse(readFileSync(join(dir, "github-app-secrets.json"), "utf8"))).toEqual({
    clientSecret: "fake-client-secret-1000",
    webhookSecret: null,
    privateKey: "fake-private-key-1000",
  });
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "github-app-secrets.json")).mode & 0o777).toBe(0o600);

  // Device flow is ticked on the sign-in app, which the desktop signs in with; the repo app is installed.
  expect(nextSteps(result)).toEqual([
    `1. Open ${github.url}/settings/apps/${signInSlug}, tick Enable Device Flow (under Identifying and authorizing users) and click Save changes. The desktop signs in with this app.`,
    `2. Open ${github.url}/apps/${repoSlug}/installations/new and install the repo app on the repositories your bots may work on.`,
  ]);
  expect(lastPage).toContain(`${github.url}/settings/apps/${signInSlug}`);
});

test("with --org both apps belong to the organization", async () => {
  const { github, dir } = fixture();

  const result = await runSetup({
    githubUrl: github.url,
    githubApiUrl: github.url,
    dir,
    org: "acme",
    open: async (url) => void (await clickCreateGitHubApps(url)),
  });

  expect(result.app.owner).toBe("acme");
  expect(result.signIn).toMatchObject({ kind: "github-app", app: { owner: "acme" } });
  expect(nextSteps(result)[0]).toContain(`${github.url}/organizations/acme/settings/apps/`);
});

test("a callback with the wrong state is refused and the real one still finishes setup", async () => {
  const { github, dir } = fixture();

  const result = await runSetup({
    githubUrl: github.url,
    githubApiUrl: github.url,
    dir,
    open: async (url) => {
      const forged = await fetch(new URL("/callback?code=fake-manifest-code-1&state=forged", url));
      expect(forged.status).toBe(400);
      expect(readLocalConfig(dir)).toBeNull();
      await clickCreateGitHubApps(url);
    },
  });

  expect(result.app.clientId).toBe("Iv-fake-client-1000");
});

test("a home set up before the sign-in app existed gets only the sign-in app", async () => {
  const { github, dir } = fixture();
  writeLocalConfig(dir, { githubApp: repoApp });

  const result = await runSetup({ githubUrl: github.url, githubApiUrl: github.url, dir, open: async (url) => void (await clickCreateGitHubApps(url)) });

  expect(github.manifests.map((manifest) => manifest.default_permissions)).toEqual([{}]);
  expect(readLocalConfig(dir)).toEqual({ githubApp: repoApp, signIn: result.signIn });
  expect(result.signIn).toMatchObject({ kind: "github-app", app: { clientId: "Iv-fake-client-1000" } });
});

test("with --oauth-client-id an OAuth App the deployer made is the sign-in app, and setup registers only the repo app", async () => {
  const { github, dir } = fixture();

  const result = await runSetup({ githubUrl: github.url, githubApiUrl: github.url, dir, oauthClientId: "oauth-client", open: async (url) => void (await clickCreateGitHubApps(url)) });

  expect(github.manifests.map((manifest) => manifest.default_permissions)).toEqual([{ contents: "write", pull_requests: "write" }]);
  expect(readLocalConfig(dir)?.signIn).toEqual({ kind: "oauth-app", clientId: "oauth-client" });
  expect(nextSteps(result)).toEqual([expect.stringMatching(/^1\. Open .*\/installations\/new and install the repo app/)]);
});

test("--oauth-client-id switches a finished setup to an OAuth App without opening GitHub", async () => {
  const { github, dir } = fixture();
  const signIn = { kind: "github-app" as const, app: { ...repoApp, id: 2, clientId: "Iv-sign-in" } };
  writeLocalConfig(dir, { githubApp: repoApp, signIn });
  let opened = false;

  await runSetup({ githubUrl: github.url, githubApiUrl: github.url, dir, oauthClientId: "oauth-client", open: async () => void (opened = true) });

  expect(opened).toBe(false);
  expect(readLocalConfig(dir)).toEqual({ githubApp: repoApp, signIn: { kind: "oauth-app", clientId: "oauth-client" } });
});

test("setup refuses to replace apps it already registered", async () => {
  const { github, dir } = fixture();
  writeLocalConfig(dir, { githubApp: repoApp, signIn: { kind: "oauth-app", clientId: "oauth-client" } });

  const run = runSetup({ githubUrl: github.url, githubApiUrl: github.url, dir, open: async () => {} });

  await expect(run).rejects.toThrow(/already set up.*chiefbot-old/);
  expect(github.manifests).toEqual([]);
});
