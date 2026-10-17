import type { GitHubAppConfig, GitHubAppSecrets } from "@chiefbot/contracts";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { readLocalConfig, writeLocalConfig, writeOwnerOnly } from "./config.ts";

// `bun run setup`: registers the deployer's own GitHub App with GitHub's App
// Manifest flow (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
// A local server on 127.0.0.1 serves a page that posts the manifest to
// github.com; after the deployer clicks Create GitHub App, GitHub redirects to
// the local /callback with a one-time code, which setup exchanges for the app's
// id, client ID and secrets. They go to the Chiefbot home (config.ts).

export type SetupOptions = {
  // https://github.com and https://api.github.com in production; a fake in tests.
  githubUrl: string;
  githubApiUrl: string;
  // The Chiefbot home (chiefbotHome).
  dir: string;
  // Register the app under this organization instead of the deployer's account.
  org?: string;
  // Opens the local page in the deployer's browser.
  open: (url: string) => Promise<void>;
};

export type SetupResult = {
  app: GitHubAppConfig;
  // Where the deployer ticks Enable Device Flow, which a manifest cannot set.
  settingsUrl: string;
  // Where they install the app on the repositories bots may work on.
  installUrl: string;
};

// Permissions a bot's token gets, on the repositories the app is installed on.
// Signing in needs none: the desktop uses the device flow (Enable Device Flow).
const permissions = {
  // Clone, commit and push.
  contents: "write",
  // Open pull requests.
  pull_requests: "write",
  // Copilot requests for the SDK go here once ticket #21 settles the name:
  // copilot_requests: "write",
};

// GitHub's answer to POST /app-manifests/{code}/conversions (the fields setup keeps).
const Conversion = z.object({
  id: z.number().int(),
  slug: z.string(),
  owner: z.object({ login: z.string(), type: z.string() }),
  html_url: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
  webhook_secret: z.string().nullable(),
  pem: z.string(),
});

// Resolves once the app is registered and saved. Refuses when the home already
// has an app: delete its config.json to register a new one.
export async function runSetup({ githubUrl, githubApiUrl, dir, org, open }: SetupOptions): Promise<SetupResult> {
  const existing = readLocalConfig(dir);
  if (existing) {
    throw new Error(
      `Chiefbot is already set up with the GitHub App ${existing.githubApp.slug} (${existing.githubApp.htmlUrl}). To register a new one, delete ${dir}/config.json first.`,
    );
  }
  const state = randomBytes(16).toString("hex");
  const newAppUrl = org
    ? `${githubUrl}/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : `${githubUrl}/settings/apps/new`;

  const { promise, resolve, reject } = Promise.withResolvers<SetupResult>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      // Posts the manifest straight away; the button is there if scripts are off.
      "/": (): Response => {
        const manifest = {
          name: `Chiefbot ${randomBytes(3).toString("hex")}`,
          url: "https://github.com/JorgeMenaDev/chiefbot",
          description: "Chiefbot: chief-of-staff bots that sign in as you, clone your repos and open pull requests.",
          redirect_url: `${server.url.origin}/callback`,
          public: false,
          default_permissions: permissions,
        };
        return html(`
          <form id="register" method="post" action="${escape(`${newAppUrl}?state=${state}`)}">
            <input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
            <p>Opening GitHub to register your Chiefbot GitHub App…</p>
            <button type="submit">Create the GitHub App on GitHub</button>
          </form>
          <script>document.getElementById("register").submit()</script>`);
      },
      "/callback": async (req): Promise<Response> => {
        const params = new URL(req.url).searchParams;
        const code = params.get("code");
        if (params.get("state") !== state || !code) return html("<p>This link is not from this setup run.</p>", 400);
        try {
          const result = await saveApp(code);
          resolve(result);
          return html(`<h1>Your Chiefbot GitHub App is registered</h1>${nextSteps(result).map((step) => `<p>${escape(step)}</p>`).join("")}`);
        } catch (error) {
          reject(error);
          return html(`<p>Setup failed: ${escape(String(error))}</p>`, 500);
        } finally {
          setTimeout(() => server.stop(), 0);
        }
      },
    },
    fetch: () => new Response("Not Found", { status: 404 }),
  });

  async function saveApp(code: string): Promise<SetupResult> {
    const res = await fetch(`${githubApiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub did not hand over the new app (${res.status}). Codes last an hour: run \`bun run setup\` again.`);
    const created = Conversion.parse(await res.json());
    const app: GitHubAppConfig = {
      id: created.id,
      slug: created.slug,
      clientId: created.client_id,
      owner: created.owner.login,
      htmlUrl: created.html_url,
    };
    writeOwnerOnly(
      dir,
      "github-app-secrets.json",
      `${JSON.stringify({ clientSecret: created.client_secret, webhookSecret: created.webhook_secret, privateKey: created.pem } satisfies GitHubAppSecrets, null, 2)}\n`,
    );
    writeLocalConfig(dir, { githubApp: app });
    const settingsUrl =
      created.owner.type === "Organization"
        ? `${githubUrl}/organizations/${created.owner.login}/settings/apps/${created.slug}`
        : `${githubUrl}/settings/apps/${created.slug}`;
    return { app, settingsUrl, installUrl: `${created.html_url}/installations/new` };
  }

  await open(`${server.url.origin}/`);
  return promise;
}

// The two clicks left after registering, as setup prints and shows them.
export function nextSteps({ settingsUrl, installUrl }: SetupResult): string[] {
  return [
    `1. Open ${settingsUrl}, tick Enable Device Flow (under Identifying and authorizing users) and click Save changes. The desktop signs in with it.`,
    `2. Open ${installUrl} and install the app on the repositories your bots may work on.`,
  ];
}

const html = (body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Chiefbot setup</title>${body}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
