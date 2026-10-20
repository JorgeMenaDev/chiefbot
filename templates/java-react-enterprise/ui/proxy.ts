import { NextResponse, type NextRequest } from "next/server";

// The dev-only login (Next.js 16 calls middleware "proxy"). When ACME_DEV_BASIC_AUTH
// ("user:password") is set, a page request without a token checks those credentials
// against meta's identity endpoint, through the gateway, and keeps the token the
// gateway issues as the `token` cookie. The page sends it to the gateway as a Bearer.
export async function proxy(request: NextRequest) {
  const credentials = process.env.ACME_DEV_BASIC_AUTH;
  if (!credentials || request.cookies.has("token")) return NextResponse.next();

  const identity = await fetch("http://localhost:8081/acme-meta/v1/me", {
    headers: { authorization: `Basic ${Buffer.from(credentials).toString("base64")}` },
  });
  const token = identity.headers
    .getSetCookie()
    .map((cookie) => /^auth=([^;]+)/.exec(cookie)?.[1])
    .find((value) => value !== undefined);
  if (!identity.ok || !token) {
    return new NextResponse(`Dev login failed: the gateway answered ${identity.status}.`, { status: 401 });
  }

  const response = NextResponse.next();
  response.cookies.set("token", token, { path: "/", sameSite: "strict", maxAge: 12 * 60 * 60 });
  return response;
}

// The page only: not its assets or the health check.
export const config = { matcher: "/" };
