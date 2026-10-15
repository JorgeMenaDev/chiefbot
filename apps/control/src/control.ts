import { GitHubTokens, SessionToken, type SignInResponse, type User } from "@chiefbot/contracts";
import { fetchIdentity, GitHubAuthError } from "./github.ts";
import { openStore } from "./store.ts";

export type ControlOptions = {
  port: number;
  dbPath: string;
  // api.github.com in production; a fake in tests.
  githubApiUrl: string;
};

// The control plane's HTTP server.
//   POST   /sessions          body GitHubTokens → SignInResponse
//   GET    /me                bearer session    → User
//   DELETE /sessions/current  bearer session    → 204
export function startControl({ port, dbPath, githubApiUrl }: ControlOptions) {
  const store = openStore(dbPath);

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    routes: {
      "/sessions": {
        POST: async (req) => {
          const tokens = GitHubTokens.safeParse(await req.json().catch(() => null));
          if (!tokens.success) return Response.json({ error: "invalid_tokens" }, { status: 400 });
          try {
            const identity = await fetchIdentity(githubApiUrl, tokens.data.accessToken);
            const sessionToken = SessionToken.parse(crypto.randomUUID() + crypto.randomUUID());
            const user = store.signIn(identity, tokens.data, sessionToken);
            return Response.json({ sessionToken, user } satisfies SignInResponse);
          } catch (error) {
            if (error instanceof GitHubAuthError) return Response.json({ error: "github_rejected_token" }, { status: 401 });
            throw error;
          }
        },
      },
      "/me": {
        GET: (req) => {
          const user = store.userForSession(bearer(req));
          return user ? Response.json(user satisfies User) : unauthorized();
        },
      },
      "/sessions/current": {
        DELETE: (req) => {
          store.endSession(bearer(req));
          return new Response(null, { status: 204 });
        },
      },
    },
  });

  return {
    url: server.url.origin,
    stop: () => {
      server.stop(true);
      store.close();
    },
  };
}

function bearer(req: Request) {
  return req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
