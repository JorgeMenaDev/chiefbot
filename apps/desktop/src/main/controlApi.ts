import { ApiError } from "@chiefbot/contracts";

// The Error for a response control refused, with its status and ApiError code
// (and message, if any): the window shows it, and callers can match the code.
export async function refusal(res: Response) {
  const body = ApiError.safeParse(await res.json().catch(() => null));
  const reason = body.success ? body.data.error + (body.data.message ? `: ${body.data.message}` : "") : "unknown error";
  return new Error(`Control refused (${res.status}): ${reason}`);
}
