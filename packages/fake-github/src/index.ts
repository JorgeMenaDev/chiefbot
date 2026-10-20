import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { commitFiles, createBareRepo, git, gitHttpBackend } from "./git.ts";

// A fake github.com + api.github.com for tests: the OAuth device flow, the
// refresh grant, the two API reads control makes at sign-in, private git repos
// over smart HTTP, a file in a repo, opening pull requests, registering a GitHub
// App from a manifest (what `bun run setup` does), and the deployer's repo app:
// its installations on repos, the installation tokens control mints with its
// private key (each with only the permissions asked for, among the app's), and a
// user's permission on a repo as such a token reads it. One origin serves both
// hosts' paths.
//
// Like GitHub, a user token may act on repos only as far as the app that issued
// it may (by client ID). Only the repo app has repository permissions, so only
// its user tokens reach repos, where it is installed. Every other client is a
// sign-in app (a GitHub App with no repository permissions, or an OAuth App
// with only read:user): its tokens read the user and their Copilot plan, and no
// private repo.

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
  // The repo app also has the Copilot Requests permission (`bun run setup --org-billed-copilot`).
  copilotRequests?: boolean;
};

export const defaultFakeUser: FakeGitHubUser = {
  id: 4242,
  login: "octo-user",
  copilot: { plan: "individual", sku: "free_limited_copilot" },
};

const PullRequestBody = z.object({ head: z.string(), base: z.string(), title: z.string(), body: z.string().default(""), draft: z.boolean().default(false) });

// The part of a GitHub App manifest the fake reads.
const AppManifest = z.object({
  name: z.string(),
  url: z.string(),
  redirect_url: z.string(),
  public: z.boolean().default(false),
  default_permissions: z.record(z.string(), z.string()).default({}),
});
export type FakeAppManifest = z.infer<typeof AppManifest>;

// Who opened a pull request or pushed: a user's login, or "app" for an installation token.
export type FakePullRequest = {
  repository: string;
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  by: string;
};

// What a user may do on a repo, like GitHub's read and write roles.
export type FakeRepoAccess = "read" | "write";

export type FakeRepoOptions = {
  // Each login's access. Default: the fake's user may write.
  access?: Record<string, FakeRepoAccess>;
  // Whether the deployer's repo app is installed on it. Default true.
  installed?: boolean;
};

// The deployer's repo app (what `bun run setup` saved): one key pair for every fake.
const appKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const fakeApp = { id: 777, privateKey: appKeys.privateKey, clientId: "Iv-fake-repo-app" };
// Who a user token belongs to and the client that issued it.
type FakeUserToken = { user: FakeGitHubUser; clientId: string };

// What control asks an installation token for: repos by name or by id, and permissions.
const AccessTokensBody = z.object({
  repositories: z.array(z.string()).optional(),
  repository_ids: z.array(z.number().int()).optional(),
  permissions: z.record(z.string(), z.string()),
});
export type FakeInstallationTokenRequest = z.infer<typeof AccessTokensBody>;

export function startFakeGitHub({
  user = defaultFakeUser,
  pollErrors = [],
  deviceFlowDisabled = false,
  copilotRequests = false,
}: FakeGitHubOptions = {}) {
  const deviceCode = "fake-device-code";
  const userCode = "ABCD-1234";
  const pending = [...pollErrors];
  let issued = 0;
  // Each valid access token, its user and client.
  const validAccessTokens = new Map<string, FakeUserToken>();
  // Each unused refresh token, with the access token issued with it.
  const validRefreshTokens = new Map<string, FakeUserToken & { accessToken: string }>();
  // Body of every POST to the device code and token endpoints, so tests can check what was sent.
  const deviceCodeRequests: Record<string, string>[] = [];
  const tokenRequests: Record<string, string>[] = [];
  // The client each pending device code was asked for.
  let deviceClientId = "";
  // Bare repos live here as <owner>/<name>.git.
  const repoRoot = mkdtempSync(join(tmpdir(), "fake-github-repos-"));
  const pullRequests: FakePullRequest[] = [];
  // Every push GitHub accepted, and who sent it.
  const pushes: Array<{ repository: string; by: string }> = [];
  // While set (holdGit), git's requests wait for it; `held` counts those that waited.
  let gitGate: Promise<void> | null = null;
  let held = 0;
  const bareRepo = (fullName: string) => join(repoRoot, `${fullName}.git`);
  // Each repo: its id (as GitHub numbers repos), whether the app is installed on it, and who may do what.
  const repos = new Map<string, { id: number; installed: boolean; access: Record<string, FakeRepoAccess> }>();
  // What the repo app may grant: an installation token gets only permissions among these.
  const appPermissions: Record<string, string> = {
    metadata: "read",
    contents: "write",
    pull_requests: "write",
    ...(copilotRequests ? { copilot_requests: "write" } : {}),
  };
  // Each installation token, the repos it covers and its contents permission (none, read or write).
  const installationTokens = new Map<string, { repos: Set<string>; contents: string | undefined }>();
  // The body of every installation token request, oldest first.
  const installationTokenRequests: FakeInstallationTokenRequest[] = [];
  // One installation per account the app is installed on: its id is the index here.
  const installations: string[] = [];
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
        POST: async (req) => {
          const body = Object.fromEntries(new URLSearchParams(await req.text()));
          deviceCodeRequests.push(body);
          deviceClientId = body.client_id ?? "";
          return deviceFlowDisabled
            ? Response.json({ error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" }, { status: 400 })
            : Response.json({
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          });
        },
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
            return tokenResponse(issuedWith.user, issuedWith.clientId);
          }
          if (body.device_code !== deviceCode) return Response.json({ error: "incorrect_device_code" });
          const error = pending.shift();
          if (error === "slow_down") return Response.json({ error, interval: 10 });
          if (error) return Response.json({ error });
          return tokenResponse(user, deviceClientId);
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
      // file and for a repo the token cannot read.
      "/repos/:owner/:repo/contents/:path": {
        GET: (req) => {
          const repository = `${req.params.owner}/${req.params.repo}`;
          if (!reader(bearerToken(req), repository)) return Response.json({ message: "Not Found" }, { status: 404 });
          try {
            return new Response(git(bareRepo(repository), ["show", `HEAD:${req.params.path}`]) + "\n");
          } catch {
            return Response.json({ message: "Not Found" }, { status: 404 });
          }
        },
      },
      // The repo itself. Like GitHub, 404 for a repo the token cannot read.
      "/repos/:owner/:repo": {
        GET: (req) => {
          const repository = `${req.params.owner}/${req.params.repo}`;
          if (!reader(bearerToken(req), repository)) return Response.json({ message: "Not Found" }, { status: 404 });
          return Response.json({ id: repos.get(repository)?.id, full_name: repository, private: true, default_branch: "main" });
        },
      },
      // A user's permission on the repo, read with an installation token for it.
      "/repos/:owner/:repo/collaborators/:username/permission": {
        GET: (req) => {
          const repository = `${req.params.owner}/${req.params.repo}`;
          if (!installationTokens.get(bearerToken(req))?.repos.has(repository)) return Response.json({ message: "Not Found" }, { status: 404 });
          return Response.json({ permission: repos.get(repository)?.access[req.params.username] ?? "none" });
        },
      },
      // The app's installation on the repo's account, with the app's JWT.
      "/repos/:owner/:repo/installation": {
        GET: (req) => {
          if (!appAuthorized(req)) return Response.json({ message: "A JSON web token could not be decoded" }, { status: 401 });
          if (!repos.get(`${req.params.owner}/${req.params.repo}`)?.installed) {
            return Response.json({ message: "Not Found" }, { status: 404 });
          }
          if (!installations.includes(req.params.owner)) installations.push(req.params.owner);
          return Response.json({ id: installations.indexOf(req.params.owner) + 1, account: { login: req.params.owner } });
        },
      },
      // An installation token for some of the installation's repos (names without the owner).
      "/app/installations/:id/access_tokens": {
        POST: async (req) => {
          if (!appAuthorized(req)) return Response.json({ message: "A JSON web token could not be decoded" }, { status: 401 });
          const owner = installations[Number(req.params.id) - 1];
          if (!owner) return Response.json({ message: "Not Found" }, { status: 404 });
          const body = AccessTokensBody.parse(await req.json());
          installationTokenRequests.push(body);
          const { repositories = [], repository_ids = [], permissions } = body;
          const byId = [...repos].filter(([, repo]) => repository_ids.includes(repo.id)).map(([fullName]) => fullName);
          const scope = [...repositories.map((name) => `${owner}/${name}`), ...byId];
          if (byId.length < repository_ids.length || !scope.every((repository) => repository.startsWith(`${owner}/`) && repos.get(repository)?.installed)) {
            return Response.json({ message: "There is at least one repository that does not exist or is not accessible" }, { status: 422 });
          }
          if (Object.entries(permissions).some(([name, level]) => !grants(appPermissions[name], level))) {
            return Response.json({ message: "The permissions requested are not granted to this installation." }, { status: 422 });
          }
          const token = `ghs_fake_${installationTokens.size + 1}`;
          installationTokens.set(token, { repos: new Set(scope), contents: permissions.contents });
          return Response.json(
            {
              token,
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
              permissions,
              repositories: scope.map((fullName) => ({ id: repos.get(fullName)?.id, full_name: fullName })),
            },
            { status: 201 },
          );
        },
      },
      // Like GitHub: 422 unless the head branch exists in the repo.
      "/repos/:owner/:repo/pulls": {
        POST: async (req) => {
          const repository = `${req.params.owner}/${req.params.repo}`;
          const by = writer(bearerToken(req), repository);
          if (!by) return Response.json({ message: "Not Found" }, { status: 404 });
          const { head, base, title, body, draft } = PullRequestBody.parse(await req.json());
          const branches = git(bareRepo(repository), ["branch", "--format=%(refname:short)"]).split("\n");
          if (!branches.includes(head)) return Response.json({ message: "Validation Failed" }, { status: 422 });
          const pr = { repository, number: pullRequests.length + 1, head, base, title, body, draft, by };
          pullRequests.push(pr);
          return Response.json({ number: pr.number, html_url: pullRequestUrl(pr) }, { status: 201 });
        },
      },
      // One pull request, its head as its branch is now. Like GitHub, 404 for a
      // repo the token cannot read.
      "/repos/:owner/:repo/pulls/:number": {
        GET: (req) => {
          const repository = `${req.params.owner}/${req.params.repo}`;
          const pr = pullRequests.find((candidate) => candidate.repository === repository && candidate.number === Number(req.params.number));
          if (!pr || !reader(bearerToken(req), repository)) return Response.json({ message: "Not Found" }, { status: 404 });
          const { number, title, body, head, base } = pr;
          const sha = git(bareRepo(repository), ["rev-parse", `refs/heads/${head}`]);
          return Response.json({ number, html_url: pullRequestUrl(pr), state: "open", title, body, head: { ref: head, sha }, base: { ref: base } });
        },
      },
    },
    // Every repo is private: git gets 401 until it sends a token as the Basic
    // auth password, then 404 unless the token may read the repo. A push needs a
    // user who may write, or an installation token for the repo.
    async fetch(req) {
      const url = new URL(req.url);
      const repository = url.pathname.match(/^\/([^/]+\/[^/]+)\.git\//)?.[1];
      if (!repository) return new Response("Not Found", { status: 404 });
      if (gitGate) {
        held++;
        await gitGate;
      }
      const basic = req.headers.get("authorization")?.match(/^Basic (.+)$/)?.[1];
      const password = basic ? atob(basic).split(":").slice(1).join(":") : "";
      if (!validAccessTokens.has(password) && !installationTokens.has(password)) {
        return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="GitHub"' } });
      }
      const push = url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack";
      const by = push ? writer(password, repository) : reader(password, repository);
      if (!by) return new Response("Repository not found.", { status: push ? 403 : 404 });
      const res = await gitHttpBackend(req, repoRoot);
      if (push && req.method === "POST" && res.ok) pushes.push({ repository, by });
      return res;
    },
  });

  // A pull request's page, as GitHub's html_url.
  function pullRequestUrl({ repository, number }: FakePullRequest): string {
    return `${server.url.origin}/${repository}/pull/${number}`;
  }

  // Whether an installation token may read (or write) the repo's contents.
  function installationMay(token: string, repository: string, level: "read" | "write") {
    const installation = installationTokens.get(token);
    return installation?.repos.has(repository) === true && grants(installation.contents, level);
  }

  // Who a token acts as on a repo when it may read it (a login, or "app"), else null.
  function reader(token: string, repository: string) {
    if (installationMay(token, repository, "read")) return "app";
    const user = repoAppUser(token, repository);
    return user && repos.get(repository)?.access[user.login] ? user.login : null;
  }

  // The same, for writing.
  function writer(token: string, repository: string) {
    if (installationMay(token, repository, "write")) return "app";
    const user = repoAppUser(token, repository);
    return user && repos.get(repository)?.access[user.login] === "write" ? user.login : null;
  }

  // The user of a repo app's user token, on a repo the app is installed on. Sign-in apps' tokens never qualify.
  function repoAppUser(token: string, repository: string) {
    const issued = validAccessTokens.get(token);
    return issued?.clientId === fakeApp.clientId && repos.get(repository)?.installed ? issued.user : null;
  }

  // Whether the request carries a JWT signed with the app's private key, unexpired, for the app.
  function appAuthorized(req: Request) {
    const [header = "", payload = "", signature = ""] = bearerToken(req).split(".");
    const verify = createVerify("RSA-SHA256");
    verify.update(`${header}.${payload}`);
    if (!verify.verify(appKeys.publicKey, Buffer.from(signature, "base64url"))) return false;
    const claims = z.object({ iss: z.union([z.string(), z.number()]), exp: z.number() }).parse(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
    return String(claims.iss) === String(fakeApp.id) && claims.exp * 1000 > Date.now();
  }

  // Mints a token pair GitHub accepts, as if `as` (default: the fake's user)
  // finished the device flow of `clientId` (default: a sign-in app).
  function issueTokens(as: FakeGitHubUser = user, clientId = "fake-sign-in-client") {
    issued += 1;
    const accessToken = `gho_fake_${issued}`;
    const refreshToken = `ghr_fake_${issued}`;
    validAccessTokens.set(accessToken, { user: as, clientId });
    validRefreshTokens.set(refreshToken, { accessToken, user: as, clientId });
    return { accessToken, refreshToken };
  }

  function tokenResponse(as: FakeGitHubUser, clientId: string) {
    const { accessToken, refreshToken } = issueTokens(as, clientId);
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

  const bearerToken = (req: Request) => req.headers.get("authorization")?.replace(/^(Bearer|token) /, "") ?? "";

  // The user a request's token belongs to, or undefined.
  function authorized(req: Request) {
    return validAccessTokens.get(bearerToken(req))?.user;
  }

  return {
    url: server.url.origin,
    userCode,
    deviceCodeRequests,
    tokenRequests,
    // Refresh-grant requests only.
    refreshRequests: () => tokenRequests.filter((body) => body.grant_type === "refresh_token"),
    issueTokens,
    revoke,
    pullRequests,
    pushes,
    // The deployer's repo app: control signs its JWTs with this key.
    app: fakeApp,
    // Manifests posted to the "new GitHub App" page, oldest first.
    manifests,
    installationTokenRequests,
    // The repo's id, as GitHub numbers repos.
    repoId: (fullName: string) => repos.get(fullName)?.id,
    // A private repo at <url>/<fullName>.git with one commit on main.
    createRepo(fullName: string, files: Record<string, string>, { access = { [user.login]: "write" }, installed = true }: FakeRepoOptions = {}) {
      createBareRepo(repoRoot, fullName, files);
      repos.set(fullName, { id: 9000 + repos.size, installed, access });
    },
    // A new commit holding `files` on the repo's `branch` (main by default; a new
    // one starts from main), as if someone pushed it: its SHA.
    commit: (fullName: string, files: Record<string, string>, branch = "main") => commitFiles(bareRepo(fullName), files, branch),
    // A pull request someone opened on github.com from `head`, by `login`: its URL.
    openPullRequest(fullName: string, { head, base = "main", title, body = "" }: { head: string; base?: string; title: string; body?: string }, login = user.login) {
      const pr = { repository: fullName, number: pullRequests.length + 1, head, base, title, body, draft: false, by: login };
      pullRequests.push(pr);
      return pullRequestUrl(pr);
    },
    // Holds git's requests until `release` runs, as a slow GitHub would. `held` counts the requests that waited.
    holdGit() {
      let release = () => {};
      gitGate = new Promise((resolve) => (release = resolve));
      held = 0;
      return {
        held: () => held,
        release: () => {
          gitGate = null;
          release();
        },
      };
    },
    // Gives `login` `access` to the repo, or takes theirs away (null).
    setAccess(fullName: string, login: string, access: FakeRepoAccess | null) {
      const repo = repos.get(fullName);
      if (!repo) throw new Error(`no repo ${fullName}`);
      if (access === null) delete repo.access[login];
      else repo.access[login] = access;
    },
    // Runs git in the repo's bare copy, e.g. to read what a push left there.
    git: (fullName: string, ...args: string[]) => git(bareRepo(fullName), args),
    stop: () => {
      server.stop(true);
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

// Whether a permission level `held` covers `wanted` (write covers read).
function grants(held: string | undefined, wanted: string) {
  return held === wanted || (held === "write" && wanted === "read");
}
