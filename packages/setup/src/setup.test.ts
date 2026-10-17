import { afterEach, expect, test } from "bun:test";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalConfig, writeLocalConfig } from "./config.ts";
import { runSetup } from "./setup.ts";

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

// What the deployer's browser does: load setup's local page, which posts the
// manifest form to GitHub; GitHub (the fake) redirects back to setup's callback.
async function clickCreateGitHubApp(pageUrl: string) {
  const page = await (await fetch(pageUrl)).text();
  const action = page.match(/<form[^>]* action="([^"]+)"/)?.[1] ?? "";
  const manifest = page.match(/name="manifest" value="([^"]*)"/)?.[1] ?? "";
  const unescape = (html: string) =>
    html.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
  return fetch(unescape(action), { method: "POST", body: new URLSearchParams({ manifest: unescape(manifest) }) });
}

test("setup registers the deployer's own GitHub App from a manifest and keeps it owner-only", async () => {
  const { github, dir } = fixture();
  let callbackPage = "";

  const result = await runSetup({
    githubUrl: github.url,
    githubApiUrl: github.url,
    dir,
    open: async (url) => void (callbackPage = await (await clickCreateGitHubApp(url)).text()),
  });

  const [manifest] = github.manifests;
  expect(manifest?.redirect_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  expect(manifest?.public).toBe(false);
  expect(manifest?.default_permissions).toEqual({ contents: "write", pull_requests: "write" });

  const app = readLocalConfig(dir)?.githubApp;
  expect(app).toEqual({
    id: 1000,
    slug: expect.stringMatching(/^chiefbot-/),
    clientId: "Iv-fake-client-1000",
    owner: "octo-user",
    htmlUrl: `${github.url}/apps/${app?.slug}`,
  });
  expect(result.app).toEqual(app!);
  expect(JSON.parse(readFileSync(join(dir, "github-app-secrets.json"), "utf8"))).toEqual({
    clientSecret: "fake-client-secret-1000",
    webhookSecret: null,
    privateKey: "fake-private-key-1000",
  });
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "github-app-secrets.json")).mode & 0o777).toBe(0o600);

  // The one setting a manifest cannot carry, and installing the app.
  expect(result.settingsUrl).toBe(`${github.url}/settings/apps/${app?.slug}`);
  expect(result.installUrl).toBe(`${github.url}/apps/${app?.slug}/installations/new`);
  expect(callbackPage).toContain("Enable Device Flow");
  expect(callbackPage).toContain(result.settingsUrl);
});

test("with --org the app belongs to the organization", async () => {
  const { github, dir } = fixture();

  const result = await runSetup({
    githubUrl: github.url,
    githubApiUrl: github.url,
    dir,
    org: "acme",
    open: async (url) => void (await clickCreateGitHubApp(url)),
  });

  expect(result.app.owner).toBe("acme");
  expect(result.settingsUrl).toBe(`${github.url}/organizations/acme/settings/apps/${result.app.slug}`);
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
      await clickCreateGitHubApp(url);
    },
  });

  expect(result.app.clientId).toBe("Iv-fake-client-1000");
});

test("setup refuses to replace an app it already registered", async () => {
  const { github, dir } = fixture();
  const app = { id: 1, slug: "chiefbot-old", clientId: "Iv-old", owner: "octo-user", htmlUrl: "https://github.com/apps/chiefbot-old" };
  writeLocalConfig(dir, { githubApp: app });

  const run = runSetup({ githubUrl: github.url, githubApiUrl: github.url, dir, open: async () => {} });

  await expect(run).rejects.toThrow(/already set up.*chiefbot-old/);
  expect(github.manifests).toEqual([]);
});
