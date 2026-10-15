import { ApiError } from "@chiefbot/contracts";

// The Error for a response control refused, with its status and ApiError code
// (and message, if any): the window shows it, and callers can match the code.
export async function refusal(res: Response) {
  const body = ApiError.safeParse(await res.json().catch(() => null));
  const reason = body.success ? body.data.error + (body.data.message ? `: ${body.data.message}` : "") : "unknown error";
  return new Error(`Control refused (${res.status}): ${reason}`);
}

// One authenticated call to control as the signed-in user: the session as
// bearer, the body as JSON. Resolves with the response; throws control's
// refusal when it is not ok. Used by bots.ts, routines.ts and chat.ts.
export function controlCaller({ controlUrl, session }: { controlUrl: string; session: () => string | null }) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${controlUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${session() ?? ""}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw await refusal(res);
    return res;
  };
}
