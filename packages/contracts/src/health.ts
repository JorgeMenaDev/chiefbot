import { z } from "zod";
import { ConnectionName } from "./connections.ts";
import { EnvironmentId, ServiceId } from "./ids.ts";

// Health: control's own read-only checks of what a person's connections reach
// (docs/connections.md). For each connection with a probe, control calls the
// vendor's API with the person's saved fields, with no AI in the loop, every
// HEALTH_INTERVAL_MS and on Refresh, and keeps HEALTH_KEEP_MS of results.
// Services (below) are the person's own health URLs, checked only on demand.

export const HEALTH_INTERVAL_MS = 5 * 60_000;
export const HEALTH_KEEP_MS = 24 * 3600_000;

// How healthy something is. `unknown`: the check could not look (no access, an
// API turned off, no answer), so it says nothing about the system: never ok.
export const HealthStatus = z.enum(["ok", "degraded", "down", "unknown"]);
export type HealthStatus = z.infer<typeof HealthStatus>;

const rank: Record<HealthStatus, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

// The worst of `statuses` (down, then degraded, then unknown), or ok for none.
export const worstStatus = (statuses: HealthStatus[]) =>
  statuses.reduce<HealthStatus>((worst, status) => (rank[status] > rank[worst] ? status : worst), "ok");

// One problem a check found, or one part it could not check (`unknown`).
// `url` is the vendor's page about it, such as a Google Cloud incident.
export const HealthItem = z.object({
  status: HealthStatus.exclude(["ok"]),
  title: z.string().min(1).max(300),
  detail: z.string().max(1000).optional(),
  url: z.url({ protocol: /^https$/ }).optional(),
});
export type HealthItem = z.infer<typeof HealthItem>;

// What one probe says: the overall status, a line saying why, and its problems
// (at most MAX_HEALTH_ITEMS; `summary` counts them all).
export const MAX_HEALTH_ITEMS = 20;
export const ProbeResult = z.object({
  status: HealthStatus,
  summary: z.string().min(1).max(300),
  items: z.array(HealthItem).max(MAX_HEALTH_ITEMS),
});
export type ProbeResult = z.infer<typeof ProbeResult>;

// A probe's result as control kept it; `at` is when the check started, epoch ms.
export const HealthCheck = ProbeResult.extend({ at: z.number() });
export type HealthCheck = z.infer<typeof HealthCheck>;

// One connection on the Health screen: its latest check (null until the first
// one ends) and the last HEALTH_KEEP_MS of checks, oldest first, for its status bar.
export const ConnectionHealth = z.object({
  name: ConnectionName,
  title: z.string(),
  latest: HealthCheck.nullable(),
  history: z.array(HealthCheck.pick({ at: true, status: true, summary: true })),
});
export type ConnectionHealth = z.infer<typeof ConnectionHealth>;

// Services: something a person runs themselves (a UI, an auth service, a
// metadata service, in any language) that answers a health URL, in one to
// MAX_ENVIRONMENTS environments (prod, preprod, int), each with its own URL and
// authentication. Control GETs each environment's URL when the person opens
// Health, on Refresh and on Check now, never on a timer, and keeps HEALTH_KEEP_MS
// of results. A secret is write-only: control keeps it in its SecretStore, keyed
// by environment, and never sends it back.

export const MAX_ENVIRONMENTS = 6;
// How many of an environment's latest checks the report carries, for its bar.
export const RECENT_SERVICE_CHECKS = 20;

// Each picks a lucide icon on the screen.
export const ServiceIcon = z.enum(["web", "api", "auth", "data", "messaging", "other"]);
export type ServiceIcon = z.infer<typeof ServiceIcon>;

// A health URL: http or https, with no user name or password in it (a credential
// goes under authentication, which never shows).
export const ServiceUrl = z
  .string()
  .trim()
  .max(2000)
  .pipe(z.url({ protocol: /^https?$/, error: "expected an http or https URL" }))
  .refine((text) => {
    const { username, password } = new URL(text);
    return username === "" && password === "";
  }, "put a credential under authentication, not in the URL");

// How control signs the check: no credential, `Authorization: Bearer <secret>`,
// or the header `header` with the secret as its value (an API key, or Basic auth).
// Host is control's own: it sends the request to the address it checked.
export const ServiceAuth = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("bearer") }),
  z.object({
    kind: z.literal("header"),
    header: z
      .string()
      .trim()
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/, "expected a header name, like X-API-Key")
      .refine((name) => name.toLowerCase() !== "host", "control sets Host itself"),
  }),
]);
export type ServiceAuth = z.infer<typeof ServiceAuth>;

// A token or header value, as pasted: one line.
export const ServiceSecret = z
  .string()
  .trim()
  .min(1)
  .max(8000)
  .regex(/^[^\r\n\0]*$/, "expected one line");

export const Environment = z.object({
  id: EnvironmentId,
  name: z.string().trim().min(1).max(20),
  url: ServiceUrl,
  auth: ServiceAuth,
});
export type Environment = z.infer<typeof Environment>;

export const Service = z.object({
  id: ServiceId,
  name: z.string().trim().min(1).max(40),
  icon: ServiceIcon,
  environments: z.array(Environment).min(1).max(MAX_ENVIRONMENTS),
});
export type Service = z.infer<typeof Service>;

// An environment as the Add/Edit dialog sends it: `id` for one that is saved
// already, and `secret` when its authentication needs one. Left out, the saved
// secret stays, while savedSecretKept says so.
export const EnvironmentInput = Environment.extend({ id: EnvironmentId.optional(), secret: ServiceSecret.optional() });
export type EnvironmentInput = z.infer<typeof EnvironmentInput>;

// Body of POST /health/services and PUT /health/services/:id: the whole service.
// An environment left out is deleted, with its secret and checks.
export const ServiceInput = Service.extend({ environments: z.array(EnvironmentInput).min(1).max(MAX_ENVIRONMENTS) })
  .omit({ id: true })
  .superRefine(({ environments }, ctx) => {
    const names = environments.map(({ name }) => name.toLowerCase());
    names.forEach((name, index) => {
      if (names.indexOf(name) !== index) ctx.addIssue({ code: "custom", path: ["environments", index, "name"], message: `${environments[index]?.name} is there twice` });
    });
    const ids = environments.flatMap(({ id }) => (id ? [id] : []));
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["environments"], message: "an environment is there twice" });
  });
export type ServiceInput = z.infer<typeof ServiceInput>;

// Whether an edited environment keeps its saved secret when the dialog sends
// none: only with the same kind of authentication, to the same origin, so a
// secret never follows a URL to another host unless it is typed again.
export function savedSecretKept(saved: Pick<Environment, "url" | "auth"> | undefined, next: Pick<Environment, "url" | "auth">) {
  if (!saved || saved.auth.kind === "none" || saved.auth.kind !== next.auth.kind) return false;
  try {
    return new URL(saved.url).origin === new URL(next.url).origin;
  } catch {
    return false;
  }
}

// What one check of an environment found: its status (ok: 2xx in time;
// degraded: 2xx but slow; down: anything else; unknown: control could not
// check), the HTTP code, the body's top-level `status` (Spring Boot Actuator,
// MicroProfile Health), how long it took, and what is wrong, in words. Nothing
// else of the answer is kept, and never a secret.
export const ServiceResult = z.object({
  status: HealthStatus,
  code: z.number().int().min(100).max(599).nullable(),
  bodyStatus: z.string().min(1).max(40).nullable(),
  latencyMs: z.number().int().min(0).nullable(),
  problem: z.string().min(1).max(300).nullable(),
});
export type ServiceResult = z.infer<typeof ServiceResult>;

// A result as control kept it; `at` is when the check started, epoch ms.
export const ServiceCheck = ServiceResult.extend({ at: z.number() });
export type ServiceCheck = z.infer<typeof ServiceCheck>;

// An environment on the Health screen: its latest check (null until one ends)
// and its last RECENT_SERVICE_CHECKS checks of the last HEALTH_KEEP_MS, oldest first.
export const EnvironmentHealth = Environment.extend({
  latest: ServiceCheck.nullable(),
  recent: z.array(ServiceCheck).max(RECENT_SERVICE_CHECKS),
});
export type EnvironmentHealth = z.infer<typeof EnvironmentHealth>;

export const ServiceHealth = Service.extend({ environments: z.array(EnvironmentHealth).min(1).max(MAX_ENVIRONMENTS) });
export type ServiceHealth = z.infer<typeof ServiceHealth>;

// GET /health and POST /health/refresh: the titles of every connection control
// can check, the person's connections among them that are on, in catalog order,
// and the person's services, oldest first.
export const HealthReport = z.object({
  checkable: z.array(z.string()),
  connections: z.array(ConnectionHealth),
  services: z.array(ServiceHealth),
});
export type HealthReport = z.infer<typeof HealthReport>;
