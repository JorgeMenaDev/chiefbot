import type { GitHubAppConfig, GitHubAppSecrets, SignInConfig } from "@chiefbot/contracts";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { readLocalConfig, writeLocalConfig, writeOwnerOnly } from "./config.ts";

// `bun run setup`: registers the deployer's own two GitHub Apps with GitHub's
// App Manifest flow (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
//   - the repo app (contents and pull requests write). Only control uses it,
//     through installation tokens, to reach repos for bots. With
//     --org-billed-copilot it may also make Copilot requests, so the
//     organization can pay for its projects' agents (control mints tokens with
//     that permission alone; a workspace owner turns it on).
//   - the sign-in app, with no repository permissions. The desktop signs in with
//     it, and its user tokens are what bot computers get for the Copilot SDK, so
//     a token stolen from a bot computer cannot write to any repo.
// A local server on 127.0.0.1 serves a page that posts a manifest to github.com;
// after the deployer clicks Create GitHub App, GitHub redirects to the local
// /callback with a one-time code, which setup exchanges for the app's id, client
// ID and secrets, then posts the next manifest. They go to the Chiefbot home
// (config.ts), each app as soon as it is saved: a run cut short resumes with
// the missing app.
//
// Fallback: if a sign-in app's token cannot drive Copilot, the deployer makes
// an OAuth App by hand (README) and runs setup with its client ID instead.

export type SetupOptions = {
  // https://github.com and https://api.github.com in production; a fake in tests.
  githubUrl: string;
  githubApiUrl: string;
  // The Chiefbot home (chiefbotHome).
  dir: string;
  // Register the apps under this organization instead of the deployer's account.
  org?: string;
  // Sign in with this OAuth App instead of a sign-in GitHub App.
  oauthClientId?: string;
  // Give the repo app GitHub's Copilot Requests permission, so `org` can pay
  // for its projects' agents. Needs `org`.
  orgBilledCopilot?: boolean;
  // Opens the local page in the deployer's browser.
  open: (url: string) => Promise<void>;
};

export type SetupResult = {
  // The repo app.
  app: GitHubAppConfig;
  signIn: SignInConfig;
  // Where the deployer ticks Enable Device Flow on a sign-in GitHub App this run
  // registered, which a manifest cannot set. Null otherwise.
  signInSettingsUrl: string | null;
  // Where they install the repo app on the repositories bots may work on.
  installUrl: string;
  // The organization that pays for its projects' agents' Copilot through the repo app, if any.
  copilotOrg: string | null;
};

// What each app is for, and its permissions on the repositories it is installed on.
const apps = {
  repo: {
    name: "Chiefbot",
    description: "Chiefbot's repo access: its control server clones your repos and opens pull requests for your bots, after you approve.",
    permissions: { contents: "write", pull_requests: "write" },
  },
  "sign-in": {
    name: "Chiefbot sign-in",
    description: "Signs you in to Chiefbot, whose bots run on your Copilot plan. It has no repository permissions.",
    permissions: {},
  },
};
type AppRole = keyof typeof apps;

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

// Resolves once both apps are registered or recorded and saved. Registers only
// what the home lacks; refuses when it has both, unless oauthClientId switches
// the sign-in app. Delete config.json to register new apps.
export async function runSetup({ githubUrl, githubApiUrl, dir, org, oauthClientId, orgBilledCopilot = false, open }: SetupOptions): Promise<SetupResult> {
  if (orgBilledCopilot && org === undefined) throw new Error("--org-billed-copilot needs --org: only an organization can pay for Copilot through the repo app.");
  const copilotOrg = orgBilledCopilot && org !== undefined ? org : null;
  let config = readLocalConfig(dir);
  if (config?.signIn && oauthClientId === undefined) {
    throw new Error(
      `Chiefbot is already set up with the GitHub App ${config.githubApp.slug} (${config.githubApp.htmlUrl}) and a sign-in app. To register new ones, delete ${dir}/config.json first.`,
    );
  }
  const oauth: SignInConfig | undefined = oauthClientId === undefined ? undefined : { kind: "oauth-app", clientId: oauthClientId };
  // The apps to register through the manifest flow, in order.
  const missing: AppRole[] = [...(config ? [] : ["repo" as const]), ...(oauth ? [] : ["sign-in" as const])];
  let signInSettingsUrl: string | null = null;

  const finish = (): SetupResult => {
    const app = config?.githubApp;
    const signIn = oauth ?? config?.signIn;
    if (!app || !signIn) throw new Error("setup finished without both apps");
    if (oauth) writeLocalConfig(dir, { githubApp: app, signIn: oauth });
    return { app, signIn, signInSettingsUrl, installUrl: `${app.htmlUrl}/installations/new`, copilotOrg };
  };
  if (missing.length === 0) return finish();

  const state = randomBytes(16).toString("hex");
  const newAppUrl = org
    ? `${githubUrl}/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : `${githubUrl}/settings/apps/new`;

  const { promise, resolve, reject } = Promise.withResolvers<SetupResult>();
  // A page that posts the manifest of `role` straight away; the button is there if scripts are off.
  const manifestPage = (role: AppRole, before = "") => {
    const manifest = {
      name: `${apps[role].name} ${randomBytes(3).toString("hex")}`,
      url: "https://github.com/JorgeMenaDev/chiefbot",
      description: apps[role].description,
      redirect_url: `${server.url.origin}/callback`,
      public: false,
      // Copilot Requests is a repository permission: the org-wide install covers every repo.
      default_permissions: { ...apps[role].permissions, ...(role === "repo" && copilotOrg !== null ? { copilot_requests: "write" } : {}) },
    };
    return html(`${before}
      <form id="register" method="post" action="${escape(`${newAppUrl}?state=${state}`)}">
        <input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
        <p>Opening GitHub to register your Chiefbot ${role} app…</p>
        <button type="submit">Create the ${role} app on GitHub</button>
      </form>
      <script>document.getElementById("register").submit()</script>`);
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/": (): Response => manifestPage(missing[0] ?? "repo"),
      "/callback": async (req): Promise<Response> => {
        const params = new URL(req.url).searchParams;
        const code = params.get("code");
        const role = missing[0];
        if (params.get("state") !== state || !code || !role) return html("<p>This link is not from this setup run.</p>", 400);
        try {
          await saveApp(role, code);
          missing.shift();
          const next = missing[0];
          if (next) return manifestPage(next, `<p>Your Chiefbot ${role} app is registered.</p>`);
          const result = finish();
          resolve(result);
          setTimeout(() => server.stop(), 0);
          return html(`<h1>Chiefbot is set up</h1>${nextSteps(result).map((step) => `<p>${escape(step)}</p>`).join("")}`);
        } catch (error) {
          reject(error);
          setTimeout(() => server.stop(), 0);
          return html(`<p>Setup failed: ${escape(String(error))}</p>`, 500);
        }
      },
    },
    fetch: () => new Response("Not Found", { status: 404 }),
  });

  async function saveApp(role: AppRole, code: string) {
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
    if (role === "repo") {
      writeOwnerOnly(
        dir,
        "github-app-secrets.json",
        `${JSON.stringify({ clientSecret: created.client_secret, webhookSecret: created.webhook_secret, privateKey: created.pem } satisfies GitHubAppSecrets, null, 2)}\n`,
      );
      config = { githubApp: app };
    } else {
      if (!config) throw new Error("the repo app must be saved first");
      config = { githubApp: config.githubApp, signIn: { kind: "github-app", app } };
      signInSettingsUrl =
        created.owner.type === "Organization"
          ? `${githubUrl}/organizations/${created.owner.login}/settings/apps/${created.slug}`
          : `${githubUrl}/settings/apps/${created.slug}`;
    }
    writeLocalConfig(dir, config);
  }

  await open(`${server.url.origin}/`);
  return promise;
}

// The clicks left after registering, as setup prints and shows them.
export function nextSteps({ signInSettingsUrl, installUrl, copilotOrg }: SetupResult): string[] {
  const steps = [
    ...(signInSettingsUrl === null
      ? []
      : [`Open ${signInSettingsUrl}, tick Enable Device Flow (under Identifying and authorizing users) and click Save changes. The desktop signs in with this app.`]),
    copilotOrg === null
      ? `Open ${installUrl} and install the repo app on the repositories your bots may work on.`
      : `Open ${installUrl}, install the repo app on ${copilotOrg} with All repositories (GitHub bills ${copilotOrg}'s Copilot through it), and turn on ${copilotOrg}'s policy that allows Copilot requests from GitHub App installations.`,
  ];
  return steps.map((step, i) => `${i + 1}. ${step}`);
}

const html = (body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Chiefbot setup</title>${body}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
