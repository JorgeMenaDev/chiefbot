import { createHash } from "node:crypto";

// A fake remote MCP server for tests: Streamable HTTP at /mcp, answering JSON
// (never SSE), with one tool, `list_issues`. With `oauth`, it also is its own
// OAuth authorization server the way the MCP spec describes: protected resource
// metadata, authorization server metadata with dynamic client registration, an
// authorize endpoint that approves at once, and a token endpoint with PKCE and
// refresh. Its access tokens last `accessTokenSeconds`.
export function startFakeMcpServer({ oauth = false, accessTokenSeconds = 3600 }: { oauth?: boolean; accessTokenSeconds?: number } = {}) {
  // Every tools/call, with the Authorization header it came with.
  const calls: Array<{ tool: string; authorization: string | null }> = [];
  // Every JSON-RPC method received, in order.
  const methods: string[] = [];
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  // The access tokens issued, in order.
  const issued: string[] = [];
  let next = 0;
  let tokens = 0;

  const issue = () => {
    const access = `access-${++tokens}`;
    const refresh = `refresh-${tokens}`;
    accessTokens.add(access);
    refreshTokens.add(refresh);
    issued.push(access);
    return Response.json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: accessTokenSeconds });
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const base = url.origin;
      if (url.pathname === "/mcp" && req.method === "POST") {
        const authorization = req.headers.get("authorization");
        if (oauth && !accessTokens.has(authorization?.replace(/^Bearer /, "") ?? "")) {
          return new Response("unauthorized", {
            status: 401,
            headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` },
          });
        }
        const message = (await req.json()) as { id?: number; method: string; params?: { name?: string } };
        methods.push(message.method);
        if (message.id === undefined) return new Response(null, { status: 202 });
        const answer = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "mcp-session-id": "fake-session" } });
        if (message.method === "initialize") {
          return answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
        }
        if (message.method === "tools/list") return answer({ tools: [{ name: "list_issues", inputSchema: { type: "object" } }] });
        const tool = message.params?.name ?? "";
        calls.push({ tool, authorization });
        return answer({ content: [{ type: "text", text: `${tool} ran` }] });
      }
      if (!oauth) return new Response("not found", { status: 404 });
      switch (url.pathname) {
        case "/.well-known/oauth-protected-resource/mcp":
          return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
        case "/.well-known/oauth-authorization-server":
          return Response.json({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            code_challenge_methods_supported: ["S256"],
          });
        case "/register":
          return Response.json({ client_id: `client-${++next}` }, { status: 201 });
        case "/authorize": {
          const params = url.searchParams;
          const code = `code-${++next}`;
          const redirectUri = params.get("redirect_uri") ?? "";
          codes.set(code, { clientId: params.get("client_id") ?? "", challenge: params.get("code_challenge") ?? "", redirectUri });
          return Response.redirect(`${redirectUri}?code=${code}&state=${params.get("state")}`, 302);
        }
        case "/token": {
          const form = new URLSearchParams(await req.text());
          if (form.get("grant_type") === "refresh_token") {
            if (!refreshTokens.delete(form.get("refresh_token") ?? "")) return Response.json({ error: "invalid_grant" }, { status: 400 });
            return issue();
          }
          const grant = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
          const valid = grant && grant.clientId === form.get("client_id") && grant.challenge === challenge && grant.redirectUri === form.get("redirect_uri");
          return valid ? issue() : Response.json({ error: "invalid_grant" }, { status: 400 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });

  return { url: `${server.url.origin}/mcp`, calls, methods, issued, stop: () => server.stop(true) };
}

export type FakeMcpServer = ReturnType<typeof startFakeMcpServer>;
