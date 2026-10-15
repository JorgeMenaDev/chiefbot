// A fake github.com + api.github.com for tests: the OAuth device flow, the
// refresh grant and the two API reads control makes. One origin serves both hosts' paths.

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

export function startFakeGitHub({ user = defaultFakeUser, pollErrors = [] }: FakeGitHubOptions = {}) {
  const deviceCode = "fake-device-code";
  const userCode = "ABCD-1234";
  const pending = [...pollErrors];
  let issued = 0;
  const validAccessTokens = new Set<string>();
  // Each unused refresh token and the access token issued with it.
  const validRefreshTokens = new Map<string, string>();
  // Body of every POST to the token endpoint, so tests can check what was sent.
  const tokenRequests: Record<string, string>[] = [];

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
          // Like GitHub: a refresh issues a new pair and invalidates the old one.
          if (body.grant_type === "refresh_token") {
            const oldAccessToken = validRefreshTokens.get(body.refresh_token ?? "");
            if (oldAccessToken === undefined || !body.client_id) return Response.json({ error: "bad_refresh_token" });
            revoke(body.refresh_token ?? "");
            return tokenResponse();
          }
          if (body.device_code !== deviceCode) return Response.json({ error: "incorrect_device_code" });
          const error = pending.shift();
          if (error === "slow_down") return Response.json({ error, interval: 10 });
          if (error) return Response.json({ error });
          return tokenResponse();
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
    },
  });

  // Mints a token pair GitHub accepts, as if the user finished the device flow.
  function issueTokens() {
    issued += 1;
    const accessToken = `gho_fake_${issued}`;
    const refreshToken = `ghr_fake_${issued}`;
    validAccessTokens.add(accessToken);
    validRefreshTokens.set(refreshToken, accessToken);
    return { accessToken, refreshToken };
  }

  function tokenResponse() {
    const { accessToken, refreshToken } = issueTokens();
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
    validAccessTokens.delete(validRefreshTokens.get(refreshToken) ?? "");
    validRefreshTokens.delete(refreshToken);
  }

  function authorized(req: Request) {
    const token = req.headers.get("authorization")?.replace(/^(Bearer|token) /, "");
    return token !== undefined && validAccessTokens.has(token);
  }

  return {
    url: server.url.origin,
    userCode,
    tokenRequests,
    // Refresh-grant requests only.
    refreshRequests: () => tokenRequests.filter((body) => body.grant_type === "refresh_token"),
    issueTokens,
    revoke,
    stop: () => server.stop(true),
  };
}
