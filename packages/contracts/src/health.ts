import { z } from "zod";
import { ConnectionName } from "./connections.ts";

// Health: control's own read-only checks of what a person's connections reach
// (docs/connections.md). For each connection with a probe, control calls the
// vendor's API with the person's saved fields, with no AI in the loop, every
// HEALTH_INTERVAL_MS and on Refresh, and keeps HEALTH_KEEP_MS of results.

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

// GET /health and POST /health/refresh: the titles of every connection control
// can check, and the person's connections among them that are on, in catalog order.
export const HealthReport = z.object({
  checkable: z.array(z.string()),
  connections: z.array(ConnectionHealth),
});
export type HealthReport = z.infer<typeof HealthReport>;
