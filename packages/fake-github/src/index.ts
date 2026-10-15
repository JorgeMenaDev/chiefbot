// A fake github.com + api.github.com for tests: the OAuth device flow and the two
// API reads control makes. One origin serves both hosts' paths.

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
  // Each valid access token and the user it belongs to.
  const validAccessTokens = new Map<string, FakeGitHubUser>();
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
    },
  });

  // Mints a token pair GitHub accepts, as if `as` (default: the fake's user)
  // finished the device flow.
  function issueTokens(as: FakeGitHubUser = user) {
    issued += 1;
    const accessToken = `gho_fake_${issued}`;
    validAccessTokens.set(accessToken, as);
    return { accessToken, refreshToken: `ghr_fake_${issued}` };
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
    issueTokens,
    stop: () => server.stop(true),
  };
}
