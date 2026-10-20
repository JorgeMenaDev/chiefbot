import { MAX_HEALTH_ITEMS, worstStatus, type ConnectionName, type HealthItem, type HealthStatus, type ProbeResult } from "@chiefbot/contracts";

// A probe: control's fixed, read-only health check of one connection's vendor,
// with no AI. It gets the person's saved fields (secret ones too, which never
// leave control) and gives up when `signal` aborts. Anything it could not look
// at is `unknown` with the reason, never ok.
export type Probe = (fields: Record<string, string>, signal: AbortSignal) => Promise<ProbeResult>;

// The probe of each connection name that has one (health.ts runs them).
export type Probes = Partial<Record<ConnectionName, Probe>>;

// One part of a probe (Cloud Run, GKE, incidents): its status, a few words for
// the summary, and its problems.
export type Part = { status: HealthStatus; phrase: string; items: HealthItem[] };

// A probe's result from its parts: the worst status, their phrases as the summary.
export function combine(parts: Part[]): ProbeResult {
  const items = parts.flatMap(({ items }) => items);
  return {
    status: worstStatus(parts.map(({ status }) => status)),
    summary: clip(parts.map(({ phrase }) => phrase).join(" · "), 300),
    items: items.slice(0, MAX_HEALTH_ITEMS).map((item) => ({ ...item, title: clip(item.title, 300), ...(item.detail === undefined ? {} : { detail: clip(item.detail, 1000) }) })),
  };
}

// A part that could not look, with the reason as its one item.
export const notChecked = (phrase: string, title: string, detail: string, url?: string): Part => ({
  status: "unknown",
  phrase,
  items: [{ status: "unknown", title, detail, ...(url === undefined ? {} : { url }) }],
});

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// What went wrong with a request, in words that never hold a credential: a
// timeout, or the network error's own message (requests carry credentials only
// in headers and bodies, never in their URLs).
export const failure = (error: unknown) =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "it did not answer in time" : error instanceof Error ? error.message : String(error);

// One request to a vendor API: its status and JSON body (null when it is not
// JSON). A redirect is never followed, as the Looker CLI does
// (connections/looker/looker.ts): it could carry a credential to another host.
// Throws on a network error or when `init.signal` aborts.
export async function call(url: string | URL, init: RequestInit & { signal: AbortSignal }) {
  const res = await fetch(url, { ...init, redirect: "manual" });
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body };
}

// The origin of an instance URL a person pasted (Looker, Dynatrace), or null when
// it is not one. Looker's CLI rule: https only, or http to this computer (the
// tests' fake vendors), and nothing after the host.
export function instanceOrigin(text: string) {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
    const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) return null;
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}
