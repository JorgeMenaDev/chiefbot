import {
  EnvironmentId,
  EnvironmentInput,
  HEALTH_KEEP_MS,
  savedSecretKept,
  ServiceId,
  ServiceInput,
  type Environment,
  type Service,
  type ServiceHealth,
  type ServiceResult,
  type UserId,
} from "@chiefbot/contracts";
import type { Clock } from "@chiefbot/worker/clock";
import { z } from "zod";
import { apiError, bearer, jsonWithin, unauthorized } from "../http.ts";
import type { SecretStore } from "../secrets/secretStore.ts";
import type { openStore } from "../store.ts";
import { checkEnvironment, SERVICE_TIMEOUT_MS, type Net } from "./serviceCheck.ts";

// How many checks of one person's services run at once; the rest wait their turn.
export const SERVICE_CONCURRENCY = 4;
// The most a service's body may be: six environments with their secrets.
const BODY_LIMIT = 128 * 1024;

// The SecretStore name of an environment's secret.
const secretName = (id: EnvironmentId) => `service-${id}`;

// A check whose secret could not be read. Why goes to control's log, never the screen.
const unreadable: ServiceResult = {
  status: "unknown",
  code: null,
  bodyStatus: null,
  latencyMs: null,
  problem: "Couldn't read this environment's secret from control's secret store. If it stays, enter it again under Edit.",
};

// Services: health URLs a person adds for what they run themselves, each in one or
// more environments (health/serviceCheck.ts checks one). Control checks them only
// when asked: when the person opens Health (POST /health/services/check), on
// Refresh (health.ts) and on Check now, never on a timer, at most
// SERVICE_CONCURRENCY at a time per person. It keeps the results HEALTH_KEEP_MS
// (health.ts prunes them). A secret goes to `secrets`, keyed by environment, and
// is never sent back: the dialog leaves it out to keep it (savedSecretKept). A
// check still running when its service is saved again or removed, or when
// control stops, is aborted and its result dropped.
//
// Person routes (a session):
//   POST   /health/services             body ServiceInput → 201 Service
//   PUT    /health/services/:id         body ServiceInput → Service (404 not theirs; 400 invalid_service)
//   DELETE /health/services/:id         → 204; its environments, secrets and checks go
//   POST   /health/services/check       → ServiceHealth[] once every environment of theirs was checked
//   POST   /health/services/:id/check   → ServiceHealth[] once that service's environments were checked
//   POST   /health/services/test        body EnvironmentInput → ServiceResult of the unsaved form, not kept
export function serviceHost({ store, clock, secrets, net }: { store: ReturnType<typeof openStore>; clock: Clock; secrets: SecretStore; net: Net }) {
  // The checks running now, by environment, each with what aborts it; and the Tests running.
  const running = new Map<EnvironmentId, { job: Promise<void>; abort: AbortController }>();
  const tests = new Set<AbortController>();
  const inTurn = slots(SERVICE_CONCURRENCY);

  // The saved secret of environment `id`, or null when the store refuses, has
  // none, or gives none within SERVICE_TIMEOUT_MS.
  async function savedSecret(id: EnvironmentId, stop: AbortSignal): Promise<string | null> {
    const late = new AbortController();
    const cancel = clock.setTimeout(() => late.abort(), SERVICE_TIMEOUT_MS);
    const signal = AbortSignal.any([stop, late.signal]);
    const gaveUp = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("no answer in time")), { once: true }));
    try {
      return await Promise.race([secrets.get(secretName(id)), gaveUp]);
    } catch (error) {
      if (!stop.aborted) console.error(`service check of ${id} could not read its secret`, error);
      return null;
    } finally {
      cancel();
    }
  }

  // What a check of `target` finds, signed with `secret()` when its authentication needs one.
  async function outcome(target: Pick<Environment, "url" | "auth">, secret: () => Promise<string | null>, stop: AbortSignal): Promise<ServiceResult> {
    if (target.auth.kind === "none") return checkEnvironment({ ...target, secret: null }, { net, clock, stop });
    const value = await secret();
    return value === null ? unreadable : checkEnvironment({ ...target, secret: value }, { net, clock, stop });
  }

  // Checks the person's environment as saved now and keeps the result, unless it
  // is being checked already: then it waits for that check. Never rejects.
  function check(userId: UserId, environment: Environment): Promise<void> {
    const current = running.get(environment.id);
    if (current) return current.job;
    const abort = new AbortController();
    const job = inTurn(userId, async () => {
      if (abort.signal.aborted) return;
      const at = clock.now();
      const result = await outcome(environment, () => savedSecret(environment.id, abort.signal), abort.signal);
      // Saved again, removed or control stopped meanwhile: the result is stale.
      if (!abort.signal.aborted && store.services.environment(userId, environment.id)) store.services.record(environment.id, { ...result, at });
    })
      .catch((error: unknown) => console.error(`service check of ${environment.id} failed: ${error instanceof Error ? error.name : "unknown error"}`))
      .finally(() => {
        if (running.get(environment.id)?.job === job) running.delete(environment.id);
      });
    running.set(environment.id, { job, abort });
    return job;
  }

  const checkServices = (userId: UserId, services: Service[]) =>
    Promise.all(services.flatMap(({ environments }) => environments.map((environment) => check(userId, environment))));

  // The service is saved again or removed: its checks still running are aborted and dropped.
  function changed({ environments }: Service) {
    for (const { id } of environments) {
      running.get(id)?.abort.abort();
      running.delete(id);
    }
  }

  // The person's services, each environment with its latest check and recent ones.
  function report(userId: UserId): ServiceHealth[] {
    const since = clock.now() - HEALTH_KEEP_MS;
    return store.services.list(userId).map((service) => ({
      ...service,
      environments: service.environments.map((environment) => {
        const recent = store.services.recent(environment.id, since);
        return { ...environment, latest: recent.at(-1) ?? null, recent };
      }),
    }));
  }

  // Saves the person's service from the body: new when `existing` is null, else
  // replacing it. An environment's secret is needed when its authentication
  // signs, unless the saved one is kept. Secrets go first, so a saved
  // environment never lacks one; those no environment needs any more go last.
  async function save(userId: UserId, req: Request, existing: Service | null) {
    const input = ServiceInput.safeParse((await jsonWithin(req, BODY_LIMIT))?.json ?? null);
    if (!input.success) return apiError(400, "invalid_service", z.prettifyError(input.error));
    const { name, icon, environments } = input.data;
    const saved = new Map(existing?.environments.map((environment) => [environment.id, environment]));
    for (const environment of environments) {
      if (environment.id && !saved.has(environment.id)) return apiError(400, "invalid_service", `${environment.name} is not an environment of this service`);
      const kept = savedSecretKept(environment.id && saved.get(environment.id), environment);
      if (environment.auth.kind !== "none" && environment.secret === undefined && !kept) {
        return apiError(400, "invalid_service", `${environment.name} needs its ${environment.auth.kind === "bearer" ? "token" : "header value"}`);
      }
    }
    const service: Service = {
      id: existing?.id ?? ServiceId.parse(`service_${crypto.randomUUID()}`),
      name,
      icon,
      environments: environments.map(({ id, name, url, auth }) => ({ id: id ?? EnvironmentId.parse(`env_${crypto.randomUUID()}`), name, url, auth })),
    };
    await Promise.all(
      service.environments.map(async ({ id, auth }, index) => {
        const secret = environments[index]?.secret;
        if (auth.kind !== "none" && secret !== undefined) await secrets.put(secretName(id), secret);
      }),
    );
    if (existing) changed(existing);
    store.services.save(userId, service, clock.now());
    const signing = new Set(service.environments.flatMap(({ id, auth }) => (auth.kind === "none" ? [] : [id])));
    await Promise.all([...saved.keys()].filter((id) => !signing.has(id)).map((id) => secrets.delete(secretName(id))));
    return Response.json(service satisfies Service, { status: existing ? 200 : 201 });
  }

  // Checks the unsaved form of one environment once, keeping nothing. Without a
  // secret, an environment of the person's own uses its saved one, while kept.
  async function test(userId: UserId, req: Request) {
    const input = EnvironmentInput.safeParse((await jsonWithin(req, BODY_LIMIT))?.json ?? null);
    if (!input.success) return apiError(400, "invalid_service", z.prettifyError(input.error));
    const { id, url, auth, secret } = input.data;
    const saved = id ? store.services.environment(userId, id) : null;
    if (id && !saved) return apiError(404, "not_found");
    if (auth.kind !== "none" && secret === undefined && !savedSecretKept(saved?.environment, input.data)) {
      return apiError(400, "invalid_service", `Enter the ${auth.kind === "bearer" ? "token" : "header value"} to test`);
    }
    const abort = new AbortController();
    tests.add(abort);
    try {
      const signWith = () => (secret !== undefined ? Promise.resolve(secret) : id ? savedSecret(id, abort.signal) : Promise.resolve(null));
      const result = await inTurn(userId, () => outcome({ url, auth }, signWith, abort.signal));
      return Response.json(result satisfies ServiceResult);
    } finally {
      tests.delete(abort);
    }
  }

  // Runs a person route for the signed-in user; 401 otherwise.
  const signedIn =
    <Req extends Request>(handle: (userId: UserId, req: Req) => Response | Promise<Response>) =>
    (req: Req) => {
      const user = store.userForSession(bearer(req));
      return user ? handle(user.id, req) : unauthorized();
    };
  // Runs a route of one of the person's services; 404 when it is not theirs.
  const ofService = (handle: (userId: UserId, service: Service, req: Request) => Response | Promise<Response>) =>
    signedIn((userId, req: Bun.BunRequest<"/health/services/:id">) => {
      const service = store.services.get(userId, ServiceId.parse(req.params.id));
      return service ? handle(userId, service, req) : apiError(404, "not_found");
    });

  const routes = {
    "/health/services": {
      POST: signedIn((userId, req) => save(userId, req, null)),
    },
    "/health/services/check": {
      POST: signedIn(async (userId) => {
        await checkServices(userId, store.services.list(userId));
        return Response.json(report(userId) satisfies ServiceHealth[]);
      }),
    },
    "/health/services/test": {
      POST: signedIn(test),
    },
    "/health/services/:id": {
      PUT: ofService((userId, service, req) => save(userId, req, service)),
      DELETE: ofService(async (userId, service) => {
        changed(service);
        store.services.remove(userId, service.id);
        await Promise.all(service.environments.map(({ id }) => secrets.delete(secretName(id))));
        return new Response(null, { status: 204 });
      }),
    },
    "/health/services/:id/check": {
      POST: signedIn(async (userId, req: Bun.BunRequest<"/health/services/:id/check">) => {
        const service = store.services.get(userId, ServiceId.parse(req.params.id));
        if (!service) return apiError(404, "not_found");
        await checkServices(userId, [service]);
        return Response.json(report(userId) satisfies ServiceHealth[]);
      }),
    },
  };

  return {
    routes,
    report,
    // Checks every environment of the person's services (Refresh).
    checkAll: async (userId: UserId) => void (await checkServices(userId, store.services.list(userId))),
    stop() {
      for (const { abort } of running.values()) abort.abort();
      for (const abort of tests) abort.abort();
    },
  };
}

// Runs each job once one of `max` slots of its person is free, in the order they came.
function slots(max: number) {
  const people = new Map<UserId, { active: number; waiting: Array<() => void> }>();
  return async <T>(userId: UserId, job: () => Promise<T>): Promise<T> => {
    const person = people.get(userId) ?? { active: 0, waiting: [] };
    people.set(userId, person);
    if (person.active < max) person.active++;
    // A finished job hands its slot straight on, so no newcomer slips in between.
    else await new Promise<void>((resolve) => person.waiting.push(resolve));
    try {
      return await job();
    } finally {
      const next = person.waiting.shift();
      if (next) next();
      else if (--person.active === 0) people.delete(userId);
    }
  };
}
