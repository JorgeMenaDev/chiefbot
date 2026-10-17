import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// A member's own credential for a personal-oauth connector, as the SecretStore
// keeps it (JSON). A pasted token has only `accessToken`; an OAuth sign-in also
// has what refreshing it takes. expiresAt is epoch milliseconds.
export const PersonalCredential = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  tokenEndpoint: z.string().optional(),
  clientId: z.string().optional(),
});
export type PersonalCredential = z.infer<typeof PersonalCredential>;

// What finishing a sign-in needs, kept by control between the start and its callback.
export type PendingSignIn = { clientId: string; tokenEndpoint: string; verifier: string; redirectUri: string; resource: string };

const ResourceMetadata = z.object({ authorization_servers: z.array(z.string()).min(1) });
const ServerMetadata = z.object({ authorization_endpoint: z.url(), token_endpoint: z.url(), registration_endpoint: z.url() });
const Registration = z.object({ client_id: z.string() });
const TokenAnswer = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number().optional() });

// The JSON at `url`, or null when it cannot be fetched.
async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  try {
    const res = await fetch(url, init);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// RFC 8414 and RFC 9728 put the well-known segment between the host and the path.
const wellKnown = (url: string, suffix: string) => {
  const { origin, pathname } = new URL(url);
  return `${origin}/.well-known/${suffix}${pathname === "/" ? "" : pathname.replace(/\/$/, "")}`;
};

// Starts an MCP server's OAuth sign-in as the MCP authorization spec describes:
// protected resource metadata names the authorization server, its metadata names
// the endpoints, and dynamic client registration gives control a client id. Null
// when the server offers no such sign-in (no metadata, or no registration
// endpoint, like GitHub's): the member pastes a token instead.
export async function startSignIn({ serverUrl, scope, redirectUri, state }: { serverUrl: string; scope: string; redirectUri: string; state: string }) {
  const resource = ResourceMetadata.safeParse(await fetchJson(wellKnown(serverUrl, "oauth-protected-resource")));
  const issuer = resource.success ? (resource.data.authorization_servers[0] ?? serverUrl) : new URL(serverUrl).origin;
  const metadata = ServerMetadata.safeParse(
    (await fetchJson(wellKnown(issuer, "oauth-authorization-server"))) ?? (await fetchJson(wellKnown(issuer, "openid-configuration"))),
  );
  if (!metadata.success) return null;
  const registration = Registration.safeParse(
    await fetchJson(metadata.data.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Chiefbot",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  if (!registration.success) return null;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(metadata.data.authorization_endpoint);
  const params = {
    response_type: "code",
    client_id: registration.data.client_id,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    resource: serverUrl,
    ...(scope === "" ? {} : { scope }),
  };
  for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value);
  const pending: PendingSignIn = { clientId: registration.data.client_id, tokenEndpoint: metadata.data.token_endpoint, verifier, redirectUri, resource: serverUrl };
  return { authorizeUrl: authorize.toString(), pending };
}

// One token request; the credential it grants, or null when refused.
async function requestToken(tokenEndpoint: string, clientId: string, form: Record<string, string>): Promise<PersonalCredential | null> {
  const answer = TokenAnswer.safeParse(
    await fetchJson(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...form, client_id: clientId }),
    }),
  );
  if (!answer.success) return null;
  const { access_token, refresh_token, expires_in } = answer.data;
  return {
    accessToken: access_token,
    tokenEndpoint,
    clientId,
    ...(refresh_token === undefined ? {} : { refreshToken: refresh_token }),
    ...(expires_in === undefined ? {} : { expiresAt: Date.now() + expires_in * 1000 }),
  };
}

// Trades the callback's code for the member's credential; null when refused.
export const finishSignIn = (pending: PendingSignIn, code: string) =>
  requestToken(pending.tokenEndpoint, pending.clientId, {
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
    resource: pending.resource,
  });

// The credential itself while it has a minute or more left (or never expires);
// otherwise a refreshed one, or null when it cannot be refreshed.
export async function refreshed(credential: PersonalCredential): Promise<PersonalCredential | null> {
  if (credential.expiresAt === undefined || credential.expiresAt > Date.now() + 60_000) return credential;
  const { refreshToken, tokenEndpoint, clientId } = credential;
  if (!refreshToken || !tokenEndpoint || !clientId) return null;
  const next = await requestToken(tokenEndpoint, clientId, { grant_type: "refresh_token", refresh_token: refreshToken });
  // A server may keep the refresh token the same and leave it out of its answer.
  return next && { refreshToken, ...next };
}
