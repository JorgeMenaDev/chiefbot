import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBareRepo, git, gitHttpBackend } from "./git.ts";

// A fake github.com + api.github.com for tests: the OAuth device flow, the
// refresh grant, the API reads control makes, private git repos over smart
// HTTP, opening pull requests, and registering a GitHub App from a manifest
// (what `bun run setup` does). One origin serves both hosts' paths.

export type FakeGitHubUser = {
  id: number;
  login: string;
  copilot: { plan: string; sku: string } | null;
};

// Answers the token endpoint gives before it issues tokens, in order.
type PollError = "authorization_pending" | "slow_down" | "access_denied" | "expired_token";

export type FakeGitHubOptions = {
  user?: FakeGitHubUser;
  pollErrors?: PollError[];
  // The app's Enable Device Flow box is unticked.
  deviceFlowDisabled?: boolean;
};

export const defaultFakeUser: FakeGitHubUser = {
  id: 4242,
  login: "octo-user",
  copilot: { plan: "individual", sku: "free_limited_copilot" },
};

const PullRequestBody = z.object({ head: z.string(), base: z.string(), title: z.string(), body: z.string().default("") });

// The part of a GitHub App manifest the fake reads.
const AppManifest = z.object({
  name: z.string(),
  url: z.string(),
  redirect_url: z.string(),
  public: z.boolean().default(false),
  default_permissions: z.record(z.string(), z.string()).default({}),
});
export type FakeAppManifest = z.infer<typeof AppManifest>;

export type FakePullRequest = { repository: string; number: number; head: string; base: string; title: string; body: string };

export function startFakeGitHub({ user = defaultFakeUser, pollErrors = [], deviceFlowDisabled = false }: FakeGitHubOptions = {}) {
  const deviceCode = "fake-device-code";
  const userCode = "ABCD-1234";
  const pending = [...pollErrors];
  let issued = 0;
  // Each valid access token and the user it belongs to.
  const validAccessTokens = new Map<string, FakeGitHubUser>();
  // Each unused refresh token, with the access token issued with it and its user.
  const validRefreshTokens = new Map<string, { accessToken: string; user: FakeGitHubUser }>();
  // Body of every POST to the token endpoint, so tests can check what was sent.
  const tokenRequests: Record<string, string>[] = [];
  // Bare repos live here as <owner>/<name>.git.
  const repoRoot = mkdtempSync(join(tmpdir(), "fake-github-repos-"));
  const pullRequests: FakePullRequest[] = [];
  const bareRepo = (fullName: string) => join(repoRoot, `${fullName}.git`);
  // Every manifest posted to the "new GitHub App" page, and the apps waiting for
  // their one-time code to be converted.
  const manifests: FakeAppManifest[] = [];
  const pendingApps = new Map<string, { manifest: FakeAppManifest; owner: { login: string; type: "User" | "Organization" } }>();

  // Like github.com/settings/apps/new after the user clicks Create GitHub App:
  // registers the app and redirects to the manifest's redirect_url with a code.
  async function registerApp(req: Request, owner: { login: string; type: "User" | "Organization" }) {
    const form = new URLSearchParams(await req.text());
    const manifest = AppManifest.parse(JSON.parse(form.get("manifest") ?? ""));
    manifests.push(manifest);
    const code = `fake-manifest-code-${manifests.length}`;
    pendingApps.set(code, { manifest, owner });
    const redirect = new URL(manifest.redirect_url);
    redirect.searchParams.set("code", code);
    const state = new URL(req.url).searchParams.get("state");
    if (state !== null) redirect.searchParams.set("state", state);
    return Response.redirect(redirect.toString(), 302);
  }

  const server = Bun.serve({
    port: 0,
    routes: {
      "/login/device/code": {
        POST: () =>
          deviceFlowDisabled
            ? Response.json({ error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" }, { status: 400 })
            : Response.json({
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }),
      },
      "/login/oauth/access_token": {
        POST: async (req) => {
          const body = Object.fromEntries(new URLSearchParams(await req.text()));
          tokenRequests.push(body);
          // Like GitHub: a refresh issues a new pair and invalidates the old one.
          if (body.grant_type === "refresh_token") {
            const issuedWith = validRefreshTokens.get(body.refresh_token ?? "");
            if (!issuedWith || !body.client_id) return Response.json({ error: "bad_refresh_token" });
            revoke(body.refresh_token ?? "");
            return tokenResponse(issuedWith.user);
          }
          if (body.device_code !== deviceCode) return Response.json({ error: "incorrect_device_code" });
          const error = pending.shift();
          if (error === "slow_down") return Response.json({ error, interval: 10 });
          if (error) return Response.json({ error });
          return tokenResponse();
        },
      },
      "/settings/apps/new": { POST: (req) => registerApp(req, { login: user.login, type: "User" }) },
      "/organizations/:org/settings/apps/new": {
        POST: (req) => registerApp(req, { login: req.params.org, type: "Organization" }),
      },
      // Like GitHub: each code converts once, into the app's id, client ID and secrets.
      "/app-manifests/:code/conversions": {
        POST: (req) => {
          const pending = pendingApps.get(req.params.code);
          if (!pending) return Response.json({ message: "Not Found" }, { status: 404 });
          pendingApps.delete(req.params.code);
          const id = 1000 + manifests.indexOf(pending.manifest);
          const slug = pending.manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          return Response.json(
            {
              id,
              slug,
              name: pending.manifest.name,
              owner: pending.owner,
              html_url: `${new URL(req.url).origin}/apps/${slug}`,
              client_id: `Iv-fake-client-${id}`,
              client_secret: `fake-client-secret-${id}`,
              webhook_secret: null,
              pem: `fake-private-key-${id}`,
              permissions: pending.manifest.default_permissions,
            },
            { status: 201 },
          );
        },
      },
      "/user": {
        GET: (req) => {
          const user = authorized(req);
          if (!user) return Response.json({ message: "Bad credentials" }, { status: 401 });
          return Response.json({ id: user.id, login: user.login });
        },
      },
      "/copilot_internal/user": {
        GET: (req) => {
          const user = authorized(req);
          if (!user) return Response.json({ message: "Bad credentials" }, { status: 401 });
          if (!user.copilot) return Response.json({ message: "Not Found" }, { status: 404 });
          return Response.json({ login: user.login, copilot_plan: user.copilot.plan, access_type_sku: user.copilot.sku });
        },
      },
      // A file at the root of the repo's default branch, raw (what Accept:
      // application/vnd.github.raw+json asks for). Like GitHub, 404 for a missing
      // file and for a repo the token cannot see.
      "/repos/:owner/:repo/contents/:path": {
        GET: (req) => {
          if (!authorized(req)) return Response.json({ message: "Bad credentials" }, { status: 401 });
          const repository = `${req.params.owner}/${req.params.repo}`;
          if (!existsSync(bareRepo(repository))) return Response.json({ message: "Not Found" }, { status: 404 });
          try {
            return new Response(git(bareRepo(repository), ["show", `HEAD:${req.params.path}`]) + "\n");
          } catch {
            return Response.json({ message: "Not Found" }, { status: 404 });
          }
        },
      },
      // Like GitHub: 422 unless the head branch exists in the repo.
      "/repos/:owner/:repo/pulls": {
        POST: async (req) => {
          if (!authorized(req)) return Response.json({ message: "Bad credentials" }, { status: 401 });
          const repository = `${req.params.owner}/${req.params.repo}`;
          if (!existsSync(bareRepo(repository))) return Response.json({ message: "Not Found" }, { status: 404 });
          const { head, base, title, body } = PullRequestBody.parse(await req.json());
          const branches = git(bareRepo(repository), ["branch", "--format=%(refname:short)"]).split("\n");
          if (!branches.includes(head)) return Response.json({ message: "Validation Failed" }, { status: 422 });
          const pr = { repository, number: pullRequests.length + 1, head, base, title, body };
          pullRequests.push(pr);
          return Response.json({ number: pr.number, html_url: `${new URL(req.url).origin}/${repository}/pull/${pr.number}` }, { status: 201 });
        },
      },
    },
    // Every repo is private: git gets 401 until it sends a valid access token as
    // the Basic auth password (what a credential helper supplies).
    fetch(req) {
      if (!/^\/[^/]+\/[^/]+\.git\//.test(new URL(req.url).pathname)) return new Response("Not Found", { status: 404 });
      const basic = req.headers.get("authorization")?.match(/^Basic (.+)$/)?.[1];
      const password = basic ? atob(basic).split(":").slice(1).join(":") : "";
      if (!validAccessTokens.has(password)) {
        return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="GitHub"' } });
      }
      return gitHttpBackend(req, repoRoot);
    },
  });

  // Mints a token pair GitHub accepts, as if `as` (default: the fake's user)
  // finished the device flow.
  function issueTokens(as: FakeGitHubUser = user) {
    issued += 1;
    const accessToken = `gho_fake_${issued}`;
    const refreshToken = `ghr_fake_${issued}`;
    validAccessTokens.set(accessToken, as);
    validRefreshTokens.set(refreshToken, { accessToken, user: as });
    return { accessToken, refreshToken };
  }

  function tokenResponse(as: FakeGitHubUser = user) {
    const { accessToken, refreshToken } = issueTokens(as);
    return Response.json({
      access_token: accessToken,
      expires_in: 28800,
      refresh_token: refreshToken,
      refresh_token_expires_in: 15897600,
      token_type: "bearer",
      scope: "",
    });
  }

  // Invalidates a refresh token and its access token, as a refresh or the user
  // revoking the app on github.com does.
  function revoke(refreshToken: string) {
    validAccessTokens.delete(validRefreshTokens.get(refreshToken)?.accessToken ?? "");
    validRefreshTokens.delete(refreshToken);
  }

  // The user a request's token belongs to, or undefined.
  function authorized(req: Request) {
    const token = req.headers.get("authorization")?.replace(/^(Bearer|token) /, "");
    return token === undefined ? undefined : validAccessTokens.get(token);
  }

  return {
    url: server.url.origin,
    userCode,
    tokenRequests,
    // Refresh-grant requests only.
    refreshRequests: () => tokenRequests.filter((body) => body.grant_type === "refresh_token"),
    issueTokens,
    revoke,
    pullRequests,
    // Manifests posted to the "new GitHub App" page, oldest first.
    manifests,
    // A private repo at <url>/<fullName>.git with one commit on main.
    createRepo: (fullName: string, files: Record<string, string>) => void createBareRepo(repoRoot, fullName, files),
    // Runs git in the repo's bare copy, e.g. to read what a push left there.
    git: (fullName: string, ...args: string[]) => git(bareRepo(fullName), args),
    stop: () => {
      server.stop(true);
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}
