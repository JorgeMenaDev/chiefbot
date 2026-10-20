import {
  EnvironmentId,
  EnvironmentInput,
  HEALTH_KEEP_MS,
  savedSecretKept,
  ServiceId,
  ServiceInput,
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
import type { SavedEnvironment } from "./serviceStore.ts";

// How many checks of one person's services run at once; the rest wait their turn.
export const SERVICE_CONCURRENCY = 4;
// The most a service's body may be: six environments with their secrets.
const BODY_LIMIT = 128 * 1024;

// A new SecretStore name for a secret being written (SavedEnvironment's secretName).
const newSecretName = () => `service-${crypto.randomUUID()}`;

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
// (health.ts prunes them). A secret goes to `secrets` under a new name each
// time it is written, and is never sent back: the dialog leaves it out to keep
// it (savedSecretKept). A check or Test signs with the secret its snapshot of the
// environment names, so a replaced secret never goes to the URL it replaced. A
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
  // A person's saves and removes run one at a time, each on what the last one left.
  const inOrder = queue();

  // The saved secret `name`, or null when the store refuses, has none (it was
  // replaced or removed), or gives none within SERVICE_TIMEOUT_MS.
  async function savedSecret(name: string, stop: AbortSignal): Promise<string | null> {
    const late = new AbortController();
    const cancel = clock.setTimeout(() => late.abort(), SERVICE_TIMEOUT_MS);
    const signal = AbortSignal.any([stop, late.signal]);
    const gaveUp = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("no answer in time")), { once: true }));
    try {
      return await Promise.race([secrets.get(name), gaveUp]);
    } catch (error) {
      if (!stop.aborted) console.error(`service check could not read its secret ${name}`, error);
      return null;
    } finally {
      cancel();
    }
  }

  // What a check of `url` finds, signed as `auth` says with the secret given, or else the saved one named.
  async function outcome(
    { url, auth, secret, secretName }: Pick<SavedEnvironment, "url" | "auth" | "secretName"> & { secret?: string },
    stop: AbortSignal,
  ): Promise<ServiceResult> {
    if (auth.kind === "none") return checkEnvironment({ url, auth, secret: null }, { net, clock, stop });
    const value = secret ?? (secretName === null ? null : await savedSecret(secretName, stop));
    return value === null ? unreadable : checkEnvironment({ url, auth, secret: value }, { net, clock, stop });
  }

  // Checks the person's environment as saved now and keeps the result, unless it
  // is being checked already: then it waits for that check. Never rejects.
  function check(userId: UserId, environment: SavedEnvironment): Promise<void> {
    const current = running.get(environment.id);
    if (current) return current.job;
    const abort = new AbortController();
    const job = inTurn(userId, async () => {
      if (abort.signal.aborted) return;
      const at = clock.now();
      const result = await outcome(environment, abort.signal);
      // Control stopped meanwhile; the store drops it too when the environment changed or went.
      if (!abort.signal.aborted) store.services.record(environment, { ...result, at });
    })
      .catch((error: unknown) => console.error(`service check of ${environment.id} failed: ${error instanceof Error ? error.name : "unknown error"}`))
      .finally(() => {
        if (running.get(environment.id)?.job === job) running.delete(environment.id);
      });
    running.set(environment.id, { job, abort });
    return job;
  }

  const checkSaved = (userId: UserId, environments: SavedEnvironment[]) => Promise.all(environments.map((environment) => check(userId, environment)));

  // Deletes secrets no environment holds any more. One that fails stays behind, logged.
  const forget = (names: Iterable<string>) =>
    Promise.all([...names].map((name) => secrets.delete(name).catch((error: unknown) => console.error(`could not delete the service secret ${name}`, error))));

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

  // Saves the person's service `id` from the body, or a new one when `id` is
  // null, once their saves and removes before it are done (404 when it went).
  async function save(userId: UserId, req: Request, id: ServiceId | null) {
    const input = ServiceInput.safeParse((await jsonWithin(req, BODY_LIMIT))?.json ?? null);
    if (!input.success) return apiError(400, "invalid_service", z.prettifyError(input.error));
    return inOrder(userId, async () => {
      const existing = id === null ? null : store.services.get(userId, id);
      return id !== null && !existing ? apiError(404, "not_found") : commit(userId, input.data, existing);
    });
  }

  // Saves `input` as the person's service: new when `existing` is null, else
  // replacing it. An environment's secret is needed when its authentication
  // signs, unless the saved one is kept. New secrets are written first, each
  // under a new name; then the service and the names its environments use are
  // saved at once; then the secrets no environment names any more go. When a
  // step fails, what it wrote goes and the service stays as it was.
  async function commit(userId: UserId, { name, icon, environments }: ServiceInput, existing: Service | null) {
    const before = new Map(existing ? store.services.saved(userId, existing.id).map((environment) => [environment.id, environment]) : []);
    for (const environment of environments) {
      if (environment.id && !before.has(environment.id)) return apiError(400, "invalid_service", `${environment.name} is not an environment of this service`);
      const kept = savedSecretKept(environment.id && before.get(environment.id), environment);
      if (environment.auth.kind !== "none" && environment.secret === undefined && !kept) {
        return apiError(400, "invalid_service", `${environment.name} needs its ${environment.auth.kind === "bearer" ? "token" : "header value"}`);
      }
    }
    // Each environment as it will be saved, and the secret it brings, to write under a new name.
    const next = environments.map(({ id, name, url, auth, secret }) => {
      const write = auth.kind !== "none" && secret !== undefined ? { name: newSecretName(), secret } : null;
      const secretName = auth.kind === "none" ? null : (write?.name ?? (id && before.get(id)?.secretName) ?? null);
      const environment: SavedEnvironment = { id: id ?? EnvironmentId.parse(`env_${crypto.randomUUID()}`), name, url, auth, secretName };
      return { environment, write };
    });
    const writes = next.flatMap(({ write }) => (write ? [write] : []));
    const saving = next.map(({ environment }) => environment);
    const service: Service = {
      id: existing?.id ?? ServiceId.parse(`service_${crypto.randomUUID()}`),
      name,
      icon,
      environments: saving.map(({ id, name, url, auth }) => ({ id, name, url, auth })),
    };
    const written = await Promise.allSettled(writes.map(({ name, secret }) => secrets.put(name, secret)));
    const refused = written.find((outcome) => outcome.status === "rejected");
    if (refused) {
      console.error("could not save a service's secret", refused.reason);
      await forget(writes.map(({ name }) => name));
      return apiError(503, "secrets_unavailable", "Couldn't save the secrets, so nothing changed. Try again.");
    }
    if (existing) changed(existing);
    let dropped: string[];
    try {
      dropped = store.services.save(userId, service, saving, clock.now());
    } catch (error) {
      await forget(writes.map(({ name }) => name));
      throw error;
    }
    await forget(dropped);
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
    if (auth.kind !== "none" && secret === undefined && !savedSecretKept(saved ?? undefined, input.data)) {
      return apiError(400, "invalid_service", `Enter the ${auth.kind === "bearer" ? "token" : "header value"} to test`);
    }
    const abort = new AbortController();
    tests.add(abort);
    try {
      // The saved secret named now: if it is replaced before this Test's turn, the Test finds it gone.
      const signWith = { url, auth, secretName: saved?.secretName ?? null, ...(secret === undefined ? {} : { secret }) };
      const result = await inTurn(userId, () => outcome(signWith, abort.signal));
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

  const routes = {
    "/health/services": {
      POST: signedIn((userId, req) => save(userId, req, null)),
    },
    "/health/services/check": {
      POST: signedIn(async (userId) => {
        await checkSaved(userId, store.services.saved(userId));
        return Response.json(report(userId) satisfies ServiceHealth[]);
      }),
    },
    "/health/services/test": {
      POST: signedIn(test),
    },
    "/health/services/:id": {
      PUT: signedIn((userId, req: Bun.BunRequest<"/health/services/:id">) => save(userId, req, ServiceId.parse(req.params.id))),
      DELETE: signedIn((userId, req: Bun.BunRequest<"/health/services/:id">) =>
        inOrder(userId, async () => {
          const service = store.services.get(userId, ServiceId.parse(req.params.id));
          if (!service) return apiError(404, "not_found");
          changed(service);
          await forget(store.services.remove(userId, service.id));
          return new Response(null, { status: 204 });
        }),
      ),
    },
    "/health/services/:id/check": {
      POST: signedIn(async (userId, req: Bun.BunRequest<"/health/services/:id/check">) => {
        const service = store.services.get(userId, ServiceId.parse(req.params.id));
        if (!service) return apiError(404, "not_found");
        await checkSaved(userId, store.services.saved(userId, service.id));
        return Response.json(report(userId) satisfies ServiceHealth[]);
      }),
    },
  };

  return {
    routes,
    report,
    // Checks every environment of the person's services (Refresh).
    checkAll: async (userId: UserId) => void (await checkSaved(userId, store.services.saved(userId))),
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

// Runs each person's jobs one after another, in the order they came; another
// person's do not wait. A job that fails does not stop the next.
function queue() {
  const last = new Map<UserId, Promise<void>>();
  return <T>(userId: UserId, job: () => Promise<T>): Promise<T> => {
    const run = (last.get(userId) ?? Promise.resolve()).then(job);
    const settled = run.then(
      () => {},
      () => {},
    );
    last.set(userId, settled);
    void settled.then(() => {
      if (last.get(userId) === settled) last.delete(userId);
    });
    return run;
  };
}
