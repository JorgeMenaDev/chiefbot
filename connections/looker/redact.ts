// Cuts each of `hidden` (the API secret, the session token) out of text from
// Looker, in every form an echo could hold it: as is, URL- or form-encoded, or
// JSON-escaped. The looker CLI (looker.ts) runs it on what it prints, and
// control's health probe (apps/control/src/health/looker.ts) on what it keeps.
export function redact(text: string, hidden: Array<string | undefined>) {
  for (const value of hidden) {
    if (!value) continue;
    for (const form of [value, encodeURIComponent(value), new URLSearchParams({ x: value }).toString().slice(2), JSON.stringify(value).slice(1, -1)]) {
      text = text.replaceAll(form, "[redacted]");
    }
  }
  return text;
}

// `value` (parsed JSON) with `redact` run on every string in it.
export const redactJson = (value: unknown, hidden: Array<string | undefined>): unknown =>
  JSON.parse(JSON.stringify(value) ?? "null", (_key, each: unknown) => (typeof each === "string" ? redact(each, hidden) : each));
