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
// How many scheduled checks run at once, so a restart after downtime, when
// every connection is due, does not fire every probe and token exchange together.
export const HEALTH_CONCURRENCY = 4;

// The probes control runs, by connection name. `google` is where the gcloud probe reads.
export const defaultProbes = (google: GoogleUrls): Probes => ({ gcloud: gcloudProbe(google), dynatrace: dynatraceProbe, looker: lookerProbe });

// Health: control checks each person's connections that have a probe itself,
// read-only and with no AI, using their saved fields (`fieldsOf`; secrets never
// leave control). A connection is checked when it has had no check for
// HEALTH_INTERVAL_MS (looked for each HEALTH_TICK_MS, so a new one is checked
// within a minute), at most HEALTH_CONCURRENCY at a time, and on Refresh. Checks
// are kept HEALTH_KEEP_MS, and go when the connection is turned off. A check
// still running when its connection is saved again or turned off (`changed`),
// or when control stops, is aborted and its result dropped: it was made with
// fields that are no longer the connection's.
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
  // The checks running now, by person and connection, each with what aborts it.
  const running = new Map<string, { job: Promise<void>; abort: AbortController }>();
  let stopped = false;
  let draining = false;
  let cancelTick = () => {};
  const keyOf = (userId: UserId, name: string) => `${userId}/${name}`;

  // What the probe says, or unknown when it failed outright or took too long.
  // Settles when `stop` aborts or the time is up, even if the probe does not.
  async function outcome(name: string, fields: Record<string, string>, stop: AbortSignal): Promise<ProbeResult> {
    try {
      const probe = probes[name];
      if (!probe) throw new Error(`${name} has no probe`);
      const signal = AbortSignal.any([stop, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
      const gaveUp = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return ProbeResult.parse(await Promise.race([probe(fields, signal), gaveUp]));
    } catch (error) {
      return { status: "unknown", summary: clip(`The check failed: ${failure(error)}`, 300), items: [] };
    }
  }

  // Checks the person's connection now and keeps the result, unless it is
  // being checked already: then it waits for that check. Never rejects.
  function check(userId: UserId, name: string): Promise<void> {
    const key = keyOf(userId, name);
    const current = running.get(key);
    if (current) return current.job;
    const abort = new AbortController();
    const job = (async () => {
      const at = clock.now();
      const fields = await fieldsOf(userId, name);
      if (!fields || abort.signal.aborted) return;
      const result = await outcome(name, fields, abort.signal);
      // Saved again, turned off or control stopped meanwhile: the result is stale.
      if (!abort.signal.aborted && store.connections.on(userId).has(name)) store.health.record(userId, name, { ...result, at });
    })()
      .catch((error: unknown) => console.error(`health check of ${name} failed`, error))
      .finally(() => {
        if (running.get(key)?.job === job) running.delete(key);
      });
    running.set(key, { job, abort });
    return job;
  }

  // Checks `due` HEALTH_CONCURRENCY at a time, in turn.
  async function drain(due: Array<{ userId: UserId; name: string }>) {
    const worker = async () => {
      for (let next = due.shift(); next && !stopped; next = due.shift()) await check(next.userId, next.name);
    };
    await Promise.all(Array.from({ length: HEALTH_CONCURRENCY }, worker));
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

  // Looks for connections due a check, unless the last look's checks still run.
  function tick() {
    if (stopped) return;
    try {
      const now = clock.now();
      store.health.prune(now - HEALTH_KEEP_MS);
      if (!draining) {
        draining = true;
        void drain(store.health.due(checkable.map(({ name }) => name), now - HEALTH_INTERVAL_MS)).finally(() => (draining = false));
      }
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
    // The person saved their connection `name` again or turned it off: a check
    // of it still running is aborted and dropped.
    changed(userId: UserId, name: string) {
      const key = keyOf(userId, name);
      running.get(key)?.abort.abort();
      running.delete(key);
    },
    stop() {
      stopped = true;
      cancelTick();
      for (const { abort } of running.values()) abort.abort();
    },
  };
}
