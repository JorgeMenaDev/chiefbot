import { createSign } from "node:crypto";
import { z } from "zod";

// The google-access-token exchange (ConnectionExchange): control keeps the person's
// Google credential and, for each turn, mints a one-hour access token from it.
// Only that token reaches the bot's computer.

// Google's OAuth token endpoint, where both grants go.
export const googleTokenUrl = "https://oauth2.googleapis.com/token";

// What a person may paste: a service account's key (IAM, Service accounts, Keys) or
// an authorized_user credentials JSON (what `gcloud auth application-default login` writes).
const GoogleKey = z.discriminatedUnion("type", [
  z.object({ type: z.literal("service_account"), client_email: z.string().min(1), private_key: z.string().min(1) }),
  z.object({ type: z.literal("authorized_user"), client_id: z.string().min(1), client_secret: z.string().min(1), refresh_token: z.string().min(1) }),
]);
type GoogleKey = z.infer<typeof GoogleKey>;

// `text` as a GoogleKey, or null. Never throws: a parse error could quote the key.
export function parseGoogleKey(text: string): GoogleKey | null {
  try {
    const parsed = GoogleKey.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const scope = "https://www.googleapis.com/auth/cloud-platform";
const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

// A one-hour access token for the credentials JSON `keyText`, from `tokenUrl`: a
// JWT bearer grant signed with a service account's private key, or a refresh
// grant for authorized_user. Errors name Google's error code, never the key.
// Google has `timeoutMs` to answer in full, so a slow endpoint never holds a turn.
export async function googleAccessToken(keyText: string, tokenUrl = googleTokenUrl, timeoutMs = 10_000): Promise<string> {
  const key = parseGoogleKey(keyText);
  if (!key) throw new Error("the saved key is not a service account key or authorized_user credentials JSON");
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = () => new Error(`Google's token endpoint did not answer within ${timeoutMs} ms`);
  const res = await fetch(tokenUrl, { method: "POST", body: new URLSearchParams(grant(key, tokenUrl)), signal }).catch((error: unknown) => {
    throw signal.aborted ? timedOut() : error;
  });
  const body: unknown = await res.json().catch(() => null);
  if (signal.aborted) throw timedOut();
  const token = z.object({ access_token: z.string().min(1) }).safeParse(body);
  if (res.ok && token.success) return token.data.access_token;
  const error = z.object({ error: z.string().max(100) }).safeParse(body);
  throw new Error(`Google refused the saved key: ${res.status} ${error.success ? error.data.error : ""}`.trim());
}

function grant(key: GoogleKey, tokenUrl: string): Record<string, string> {
  if (key.type === "authorized_user") {
    return { grant_type: "refresh_token", client_id: key.client_id, client_secret: key.client_secret, refresh_token: key.refresh_token };
  }
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iss: key.client_email, scope, aud: tokenUrl, iat, exp: iat + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  return { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` };
}
