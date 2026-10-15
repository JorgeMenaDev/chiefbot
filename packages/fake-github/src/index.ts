import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBareRepo, git, gitHttpBackend } from "./git.ts";

// A fake github.com + api.github.com for tests: the OAuth device flow, the two
// API reads control makes, private git repos over HTTPS-style smart HTTP, and
// opening pull requests. One origin serves both hosts' paths.

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
};

export const defaultFakeUser: FakeGitHubUser = {
  id: 4242,
  login: "octo-jorge",
  copilot: { plan: "individual", sku: "free_limited_copilot" },
};

const PullRequestBody = z.object({ head: z.string(), base: z.string(), title: z.string(), body: z.string().default("") });

export type FakePullRequest = { repository: string; number: number; head: string; base: string; title: string; body: string };

export function startFakeGitHub({ user = defaultFakeUser, pollErrors = [] }: FakeGitHubOptions = {}) {
  const deviceCode = "fake-device-code";
  const userCode = "ABCD-1234";
  const pending = [...pollErrors];
  let issued = 0;
  const validAccessTokens = new Set<string>();
  // Body of every POST to the token endpoint, so tests can check what was sent.
  const tokenRequests: Record<string, string>[] = [];
  // Bare repos live here as <owner>/<name>.git.
  const repoRoot = mkdtempSync(join(tmpdir(), "fake-github-repos-"));
  const pullRequests: FakePullRequest[] = [];
  const bareRepo = (fullName: string) => join(repoRoot, `${fullName}.git`);

  const server = Bun.serve({
    port: 0,
    routes: {
      "/login/device/code": {
        POST: () =>
          Response.json({
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
          if (body.device_code !== deviceCode) return Response.json({ error: "incorrect_device_code" });
          const error = pending.shift();
          if (error === "slow_down") return Response.json({ error, interval: 10 });
          if (error) return Response.json({ error });
          const { accessToken, refreshToken } = issueTokens();
          return Response.json({
            access_token: accessToken,
            expires_in: 28800,
            refresh_token: refreshToken,
            refresh_token_expires_in: 15897600,
            token_type: "bearer",
            scope: "",
          });
        },
      },
      "/user": {
        GET: (req) => {
          if (!authorized(req)) return Response.json({ message: "Bad credentials" }, { status: 401 });
          return Response.json({ id: user.id, login: user.login });
        },
      },
      "/copilot_internal/user": {
        GET: (req) => {
          if (!authorized(req)) return Response.json({ message: "Bad credentials" }, { status: 401 });
          if (!user.copilot) return Response.json({ message: "Not Found" }, { status: 404 });
          return Response.json({ login: user.login, copilot_plan: user.copilot.plan, access_type_sku: user.copilot.sku });
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

  // Mints a token pair GitHub accepts, as if the user finished the device flow.
  function issueTokens() {
    issued += 1;
    const accessToken = `gho_fake_${issued}`;
    validAccessTokens.add(accessToken);
    return { accessToken, refreshToken: `ghr_fake_${issued}` };
  }

  function authorized(req: Request) {
    const token = req.headers.get("authorization")?.replace(/^(Bearer|token) /, "");
    return token !== undefined && validAccessTokens.has(token);
  }

  return {
    url: server.url.origin,
    userCode,
    tokenRequests,
    issueTokens,
    pullRequests,
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
