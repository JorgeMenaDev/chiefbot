import { SERVICE_PROBLEM_MAX, type ServiceAuth, type ServiceResult } from "@chiefbot/contracts";
import type { Clock } from "@chiefbot/worker/clock";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { z } from "zod";

// A check with no full answer in this long is down.
export const SERVICE_TIMEOUT_MS = 10_000;
// A 2xx slower than this is degraded (Slow).
export const SERVICE_SLOW_MS = 2_000;
// How much of the body a check reads, for its top-level `status`.
export const SERVICE_BODY_BYTES = 64 * 1024;

// The network a check uses: Bun's fetch and the system resolver. Fakes in tests.
export type Net = {
  fetch: (url: string, init: BunFetchRequestInit) => Promise<Response>;
  // Every address `hostname` resolves to.
  lookup: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
};

export const systemNet: Net = {
  fetch: (url, init) => fetch(url, init),
  lookup: (hostname) => lookup(hostname, { all: true }),
};

// Cloud metadata servers hand out the credentials of the machine control runs
// on, so a check never asks one: by name, or by any address a name resolves to.
const metadataAddresses = new BlockList();
metadataAddresses.addSubnet("169.254.0.0", 16, "ipv4");
metadataAddresses.addAddress("fd00:ec2::254", "ipv6");
const metadataHosts = ["metadata.google.internal"];
const isMetadata = (address: string) => metadataAddresses.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");

const BodyStatus = z.object({ status: z.string() });
const downStatuses = ["DOWN", "OUT_OF_SERVICE"];

// One check of a service's environment: a GET of `url`, signed with `secret` as
// `auth` says, with no redirect followed (a secret never reaches another host).
// It resolves the name itself, refuses a cloud metadata address, and sends the
// request to the address it checked, so a second lookup cannot point it
// elsewhere. Gives up after SERVICE_TIMEOUT_MS, or when `stop` aborts. Never
// throws, and the result never holds the secret or the service's own words,
// beyond a short top-level `status`; its problem is cut to SERVICE_PROBLEM_MAX.
export async function checkEnvironment(
  { url, auth, secret }: { url: string; auth: ServiceAuth; secret: string | null },
  { net, clock, stop }: { net: Net; clock: Clock; stop: AbortSignal },
): Promise<ServiceResult> {
  const deadline = new AbortController();
  const cancel = clock.setTimeout(() => deadline.abort(), SERVICE_TIMEOUT_MS);
  const signal = AbortSignal.any([stop, deadline.signal]);
  const target = new URL(url);
  // Text the service chose, which might echo the secret, is dropped when it does.
  const leaks = (text: string) => secret !== null && secret !== "" && text.includes(secret);
  let result: ServiceResult;
  try {
    const started = clock.now();
    result = await ask(target, { auth, secret, net, signal, leaks, elapsed: () => clock.now() - started });
  } catch (error) {
    result = failed(signal.aborted ? `No answer within ${SERVICE_TIMEOUT_MS / 1000} s` : unreachable(error, target.hostname, leaks));
  } finally {
    cancel();
  }
  const problem = result.problem && secret ? result.problem.replaceAll(secret, "…") : result.problem;
  return { ...result, problem: problem && problem.length > SERVICE_PROBLEM_MAX ? `${problem.slice(0, SERVICE_PROBLEM_MAX - 1)}…` : problem };
}

type Ask = { auth: ServiceAuth; secret: string | null; net: Net; signal: AbortSignal; leaks: (text: string) => boolean; elapsed: () => number };

async function ask(url: URL, { auth, secret, net, signal, leaks, elapsed }: Ask): Promise<ServiceResult> {
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (metadataHosts.includes(hostname.toLowerCase().replace(/\.$/, ""))) return metadata(url.host);
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(net.lookup(hostname), signal);
  if (addresses.some(({ address }) => isMetadata(address))) return metadata(url.host);
  // IPv4 first, as most local services (and the mock) listen on 127.0.0.1 only.
  const pinned = addresses.find(({ family }) => family === 4) ?? addresses[0];
  if (!pinned) throw Object.assign(new Error("no address"), { code: "ENOTFOUND" });
  const pinnedUrl = new URL(url);
  pinnedUrl.hostname = pinned.family === 6 ? `[${pinned.address}]` : pinned.address;
  const credential = auth.kind === "bearer" ? { authorization: `Bearer ${secret}` } : auth.kind === "header" ? { [auth.header]: secret ?? "" } : {};
  const tls =
    url.protocol === "https:" && !isIP(hostname) ? { tls: { serverName: hostname, checkServerIdentity: (_: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(hostname, cert) } } : {};

  const res = await net.fetch(pinnedUrl.href, { method: "GET", headers: { host: url.host, ...credential }, redirect: "manual", signal, ...tls });
  const code = res.status;
  if (code >= 300 && code < 400) {
    await res.body?.cancel().catch(() => {});
    const to = redirectHost(res.headers.get("location"), url);
    return { status: "down", code, bodyStatus: null, latencyMs: elapsed(), problem: to && !leaks(to) ? `Redirects to ${to}, which is not followed` : "Redirects, which is not followed" };
  }
  const bodyStatus = statusOf(await readUpTo(res, SERVICE_BODY_BYTES), leaks);
  const latencyMs = elapsed();
  const reportsDown = bodyStatus !== null && downStatuses.includes(bodyStatus.toUpperCase());
  const answered = { code, bodyStatus, latencyMs };
  if (code >= 200 && code < 300 && !reportsDown) {
    if (latencyMs <= SERVICE_SLOW_MS) return { status: "ok", ...answered, problem: null };
    return { status: "degraded", ...answered, problem: `Answered in ${seconds(latencyMs)}, over the ${seconds(SERVICE_SLOW_MS)} limit` };
  }
  return { status: "down", ...answered, problem: answerProblem(code, bodyStatus, auth.kind !== "none") };
}

// What is wrong with an answer that is not healthy.
function answerProblem(code: number, bodyStatus: string | null, signed: boolean) {
  if (code >= 200 && code < 300) return `Answered ${code} but reports ${bodyStatus}`;
  if (code === 401) return signed ? "Answered 401: its credential was refused" : "Answered 401: it needs authentication";
  if (code === 403) return "Answered 403: access denied";
  if (code === 404) return "Answered 404: nothing at this URL";
  return bodyStatus ? `Answered ${code} and reports ${bodyStatus}` : `Answered ${code}`;
}

// Why no answer came, in words: never the error's own message, which might quote a header.
function unreachable(error: unknown, hostname: string, leaks: (text: string) => boolean) {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return `Couldn't find ${hostname}`;
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return "Connection refused";
  if (code === "ConnectionClosed" || code === "ECONNRESET") return "The connection closed before an answer";
  const shown = /^[A-Za-z_]{1,40}$/.test(code) && !leaks(code) ? ` (${code})` : "";
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return `The TLS certificate was not accepted${shown}`;
  return `Couldn't connect${shown}`;
}

const failed = (problem: string): ServiceResult => ({ status: "down", code: null, bodyStatus: null, latencyMs: null, problem });

// A refused target: the check did not run, so it says nothing about the service.
const metadata = (host: string): ServiceResult => ({ status: "unknown", code: null, bodyStatus: null, latencyMs: null, problem: `Not checked: ${host} is a cloud metadata address` });

// The host a redirect points to, or null when its Location is missing or not a URL.
function redirectHost(location: string | null, from: URL) {
  if (location === null) return null;
  try {
    return new URL(location, from).host;
  } catch {
    return null;
  }
}

// The body's top-level `status` when it is JSON and short plain words, else null.
function statusOf(body: string, leaks: (text: string) => boolean) {
  try {
    const parsed = BodyStatus.safeParse(JSON.parse(body));
    const status = parsed.success ? parsed.data.status.trim() : "";
    return /^[\w .-]{1,40}$/.test(status) && !leaks(status) ? status : null;
  } catch {
    return null;
  }
}

// At most `max` bytes of the body, as text; the rest is never read.
async function readUpTo(res: Response, max: number) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

// `promise`, or a rejection once `signal` aborts.
function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}

// "2.5 s", "10 s".
const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;
