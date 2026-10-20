import { HEALTH_INTERVAL_MS, HEALTH_KEEP_MS, ProbeResult, type HealthReport, type UserId } from "@chiefbot/contracts";
import type { Clock } from "@chiefbot/worker/clock";
import type { CatalogConnection } from "../connections/catalog.ts";
import { bearer, unauthorized } from "../http.ts";
import type { openStore } from "../store.ts";
import { dynatraceProbe } from "./dynatrace.ts";
import { gcloudProbe, type GoogleUrls } from "./gcloud.ts";
import { lookerProbe } from "./looker.ts";
import { clip, failure, type Probes } from "./probe.ts";

// How often control looks for connections due a check.
export const HEALTH_TICK_MS = 60_000;
// A probe that takes longer than this has not answered.
export const PROBE_TIMEOUT_MS = 30_000;

// The probes control runs, by connection name. `google` is where the gcloud probe reads.
export const defaultProbes = (google: GoogleUrls): Probes => ({ gcloud: gcloudProbe(google), dynatrace: dynatraceProbe, looker: lookerProbe });

// Health: control checks each person's connections that have a probe itself,
// read-only and with no AI, using their saved fields (`fieldsOf`; secrets never
// leave control). A connection is checked when it has had no check for
// HEALTH_INTERVAL_MS (looked for each HEALTH_TICK_MS, so a new one is checked
// within a minute), and on Refresh. Checks are kept HEALTH_KEEP_MS, and go
// when the connection is turned off.
//
// Person routes (a session):
//   GET  /health          → HealthReport from the kept checks
//   POST /health/refresh  → HealthReport once each of the person's connections was checked again
export function healthHost({
  store,
  clock,
  catalog,
  probes,
  fieldsOf,
}: {
  store: ReturnType<typeof openStore>;
  clock: Clock;
  catalog: CatalogConnection[];
  probes: Probes;
  fieldsOf: (userId: UserId, name: string) => Promise<Record<string, string> | null>;
}) {
  const checkable = catalog.filter(({ name }) => probes[name] !== undefined);
  const running = new Map<string, Promise<void>>();
  let stopped = false;
  let cancelTick = () => {};

  // What the probe says, or unknown when it failed outright or took too long.
  async function outcome(name: string, fields: Record<string, string>): Promise<ProbeResult> {
    try {
      const probe = probes[name];
      if (!probe) throw new Error(`${name} has no probe`);
      return ProbeResult.parse(await probe(fields, AbortSignal.timeout(PROBE_TIMEOUT_MS)));
    } catch (error) {
      return { status: "unknown", summary: clip(`The check failed: ${failure(error)}`, 300), items: [] };
    }
  }

  // Checks the person's connection now and keeps the result, unless it is
  // being checked already: then it waits for that check. Never rejects.
  function check(userId: UserId, name: string) {
    const key = `${userId}/${name}`;
    const job =
      running.get(key) ??
      (async () => {
        const at = clock.now();
        const fields = await fieldsOf(userId, name);
        if (!fields) return;
        const result = await outcome(name, fields);
        // Turned off meanwhile, or control stopped: nothing to keep.
        if (!stopped && store.connections.on(userId).has(name)) store.health.record(userId, name, { ...result, at });
      })()
        .catch((error: unknown) => console.error(`health check of ${name} failed`, error))
        .finally(() => running.delete(key));
    running.set(key, job);
    return job;
  }

  function report(userId: UserId): HealthReport {
    const on = store.connections.on(userId);
    const since = clock.now() - HEALTH_KEEP_MS;
    return {
      checkable: checkable.map(({ title }) => title),
      connections: checkable
        .filter(({ name }) => on.has(name))
        .map(({ name, title }) => {
          const checks = store.health.checks(userId, name, since);
          return { name, title, latest: checks.at(-1) ?? null, history: checks.map(({ at, status, summary }) => ({ at, status, summary })) };
        }),
    };
  }

  function tick() {
    if (stopped) return;
    try {
      const now = clock.now();
      store.health.prune(now - HEALTH_KEEP_MS);
      for (const { userId, name } of store.health.due(checkable.map(({ name }) => name), now - HEALTH_INTERVAL_MS)) void check(userId, name);
    } catch (error) {
      console.error("health tick failed", error);
    }
    cancelTick = clock.setTimeout(tick, HEALTH_TICK_MS);
  }

  const signedIn = (handle: (userId: UserId) => Response | Promise<Response>) => (req: Request) => {
    const user = store.userForSession(bearer(req));
    return user ? handle(user.id) : unauthorized();
  };

  const routes = {
    "/health": {
      GET: signedIn((userId) => Response.json(report(userId) satisfies HealthReport)),
    },
    "/health/refresh": {
      POST: signedIn(async (userId) => {
        const on = store.connections.on(userId);
        await Promise.all(checkable.filter(({ name }) => on.has(name)).map(({ name }) => check(userId, name)));
        return Response.json(report(userId) satisfies HealthReport);
      }),
    },
  };

  return {
    routes,
    // Starts the schedule, with a first look now.
    start: tick,
    stop() {
      stopped = true;
      cancelTick();
    },
  };
}
