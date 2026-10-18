import type { ApiError, ApiErrorCode } from "@chiefbot/contracts";

// The bearer token of a request, or "" without one.
export function bearer(req: Request) {
  return req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

export function unauthorized() {
  return apiError(401, "unauthorized");
}

// Every error body control sends: an ApiError.
export function apiError(status: number, error: ApiErrorCode, message?: string) {
  return Response.json((message === undefined ? { error } : { error, message }) satisfies ApiError, { status });
}
