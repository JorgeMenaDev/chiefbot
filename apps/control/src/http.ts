import type { ApiError, ApiErrorCode } from "@chiefbot/contracts";

// The bearer token of a request, or "" without one.
export function bearer(req: Request) {
  return req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

export function unauthorized() {
  return apiError(401, "unauthorized");
}

// A request's or response's body as text, or null once it passes `limit` bytes:
// it is read in chunks, so a big one is never held whole.
export async function textWithin({ body }: Request | Response, limit: number): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body ?? []) {
    size += chunk.byteLength;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// A request's JSON body (null when it is not JSON), or null itself once the body passes `limit` bytes.
export async function jsonWithin(req: Request, limit: number): Promise<{ json: unknown } | null> {
  const text = await textWithin(req, limit);
  if (text === null) return null;
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { json: null };
  }
}

// Every error body control sends: an ApiError.
export function apiError(status: number, error: ApiErrorCode, message?: string) {
  return Response.json((message === undefined ? { error } : { error, message }) satisfies ApiError, { status });
}
