import { afterEach, expect, spyOn, test } from "bun:test";
import { HEALTH_INTERVAL_MS, HealthReport, Service, ServiceHealth, ServiceResult, type ServiceInput } from "@chiefbot/contracts";
import { fakeClock } from "@chiefbot/worker/clock";
import { z } from "zod";
import type { SecretStore } from "../secrets/secretStore.ts";
import { cleanUp, eventually, hour, startTestControl, type TestUser } from "../testControl.ts";
import { HEALTH_TICK_MS } from "./health.ts";
import type { Net } from "./serviceCheck.ts";
import { SERVICE_CONCURRENCY } from "./services.ts";

afterEach(cleanUp);

const token = "prod-token-0123456789";
const minute = 60_000;
const up = () => Response.json({ status: "UP" });

type Sent = { host: string; path: string; headers: Record<string, string>; signal: AbortSignal };

// A fake network: every name resolves to a documentation address, and `answer`
// stands in for the services, given what each check sent.
function fakeNet(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const net: Net = {
    lookup: async () => [{ address: "203.0.113.10", family: 4 }],
    fetch: async (url, init) => {
      const headers = z.record(z.string(), z.string()).parse(init.headers);
      const one = { host: headers.host ?? "", path: new URL(url).pathname, headers, signal: init.signal ?? new AbortController().signal };
      sent.push(one);
      return answer(one);
    },
  };
  return { net, sent };
}

// A SecretStore in memory; `failing` makes it refuse to read services' secrets,
// `refusing` to write that value, and `hold(value)` waits to write it.
function memorySecrets() {
  const saved = new Map<string, string>();
  const state: { failing: boolean; refusing: string | null } = { failing: false, refusing: null };
  const held = new Map<string, { reached: () => void; open: Promise<void> }>();
  const store: SecretStore = {
    get: async (name) => {
      if (state.failing && name.startsWith("service-")) throw new Error("PERMISSION_DENIED on the secret");
      return saved.get(name) ?? null;
    },
    put: async (name, value) => {
      if (value === state.refusing) throw new Error("PERMISSION_DENIED on the secret");
      const hold = held.get(value);
      if (hold) {
        hold.reached();
        await hold.open;
      }
      saved.set(name, value);
    },
    delete: async (name) => void saved.delete(name),
  };
  const services = () => [...saved].filter(([name]) => name.startsWith("service-"));
  // Holds the write of `value` until release(); `reached` settles once it waits.
  const hold = (value: string) => {
    const reached = Promise.withResolvers<void>();
    const open = Promise.withResolvers<void>();
    held.set(value, { reached: reached.resolve, open: open.promise });
    return { reached: reached.promise, release: open.resolve };
  };
  return { store, services, state, hold };
}

async function setup(answer: (sent: Sent) => Response | Promise<Response> = up, secrets?: SecretStore) {
  const time = fakeClock(Date.UTC(2026, 9, 20, 9));
  const { net, sent } = fakeNet(answer);
  const control = await startTestControl({ clock: time.clock, serviceNet: net, ...(secrets === undefined ? {} : { secrets }) });
  return { ...control, time, sent };
}

const meta = {
  name: "Meta",
  icon: "data",
  environments: [
    { name: "prod", url: "https://meta.example.com/actuator/health", auth: { kind: "bearer" }, secret: token },
    { name: "preprod", url: "https://meta-preprod.example.com/actuator/health", auth: { kind: "header", header: "X-API-Key" }, secret: "preprod-key-0123" },
    { name: "int", url: "http://meta-int.example.com/actuator/health", auth: { kind: "none" } },
  ],
} satisfies z.input<typeof ServiceInput>;
const ui = { name: "UI", icon: "web", environments: [{ name: "prod", url: "https://ui.example.com/health", auth: { kind: "none" } }] } satisfies z.input<typeof ServiceInput>;

const add = async (user: TestUser, body: z.input<typeof ServiceInput> = meta) => Service.parse(await (await user.api("POST", "/health/services", body)).json());
const report = async (user: TestUser) => HealthReport.parse(await (await user.api("GET", "/health")).json());
const checkAll = async (user: TestUser) => z.array(ServiceHealth).parse(await (await user.api("POST", "/health/services/check")).json());
const statuses = (services: ServiceHealth[]) => services.map(({ name, environments }) => [name, environments.map(({ name, latest }) => [name, latest?.status ?? null])]);
// A saved service as the dialog sends it back, with no secrets.
const asSaved = ({ name, icon, environments }: Service) => ({ name, icon, environments: environments.map(({ id, name, url, auth }) => ({ id, name, url, auth })) });

test("services are checked when Health opens, on Refresh and on Check now, never on the 5-minute timer, each environment on its own", async () => {
  const { user, time, sent } = await setup(({ host }) => (host === "meta-preprod.example.com" ? Response.json({ status: "DOWN" }, { status: 503 }) : up()));
  await add(user);

  expect(statuses((await report(user)).services)).toEqual([["Meta", [["prod", null], ["preprod", null], ["int", null]]]]);
  const opened = await checkAll(user);
  expect(statuses(opened)).toEqual([["Meta", [["prod", "ok"], ["preprod", "down"], ["int", "ok"]]]]);
  expect(opened[0]?.environments[1]?.latest).toMatchObject({ code: 503, bodyStatus: "DOWN", problem: "Answered 503 and reports DOWN" });
  // Each environment signs as it says.
  expect(sent.find(({ host }) => host === "meta.example.com")?.headers.authorization).toBe(`Bearer ${token}`);
  expect(sent.find(({ host }) => host === "meta-preprod.example.com")?.headers["X-API-Key"]).toBe("preprod-key-0123");
  expect(Object.keys(sent.find(({ host }) => host === "meta-int.example.com")?.headers ?? {})).toEqual(["host"]);

  time.advance(HEALTH_INTERVAL_MS + HEALTH_TICK_MS);
  await Bun.sleep(20);
  expect(sent).toHaveLength(3);

  await user.api("POST", "/health/refresh");
  expect(sent).toHaveLength(6);
  const second = await add(user, ui);
  const checkedNow = z.array(ServiceHealth).parse(await (await user.api("POST", `/health/services/${second.id}/check`)).json());
  expect(sent.slice(6).map(({ host }) => host)).toEqual(["ui.example.com"]);
  expect(checkedNow.map(({ name, environments }) => [name, environments.map(({ recent }) => recent.length)])).toEqual([
    ["Meta", [2, 2, 2]],
    ["UI", [1]],
  ]);

  // Checks are kept 24 hours.
  time.advance(24 * hour + minute);
  expect(statuses((await report(user)).services)).toEqual([
    ["Meta", [["prod", null], ["preprod", null], ["int", null]]],
    ["UI", [["prod", null]]],
  ]);
});

test("secrets are write-only: kept in the secret store per environment, never sent back, kept on edit only for the same host", async () => {
  const secrets = memorySecrets();
  const { user } = await setup(up, secrets.store);
  const service = await add(user);

  expect(secrets.services().map(([, value]) => value)).toEqual([token, "preprod-key-0123"]);
  const names = secrets.services().map(([name]) => name);
  const everything = JSON.stringify([service, await checkAll(user), await report(user)]);
  expect(everything).not.toContain(token);
  expect(everything).not.toContain("preprod-key-0123");

  const edit = (body: object) => user.api("PUT", `/health/services/${service.id}`, body);
  const saved = asSaved(service);
  expect((await edit(saved)).status).toBe(200);
  expect(secrets.services().map(([name]) => name)).toEqual(names);
  expect((await checkAll(user))[0]?.environments[0]?.latest?.status).toBe("ok");
  // To another host, or signing another way, the secret must be typed again.
  const moved = await edit({ ...saved, environments: [{ ...saved.environments[0], url: "https://elsewhere.example.com/health" }, ...saved.environments.slice(1)] });
  const switched = await edit({ ...saved, environments: [{ ...saved.environments[0], auth: { kind: "header", header: "X-API-Key" } }, ...saved.environments.slice(1)] });
  expect([moved.status, await moved.text()]).toEqual([400, JSON.stringify({ error: "invalid_service", message: "prod needs its token" })]);
  expect(switched.status).toBe(400);

  // An environment that stops signing, or goes, takes its secret along.
  await edit({ ...saved, environments: [{ ...saved.environments[0], auth: { kind: "none" } }, saved.environments[2]] });
  expect(secrets.services()).toEqual([]);
  const again = await add(user);
  expect(secrets.services()).toHaveLength(2);
  await user.api("DELETE", `/health/services/${again.id}`);
  expect(secrets.services()).toEqual([]);
});

test("a save that cannot write every new secret changes nothing, and leaves none of them behind", async () => {
  const secrets = memorySecrets();
  const { user, sent } = await setup(up, secrets.store);
  const service = await add(user);
  const before = secrets.services();
  const [prod, preprod, int] = asSaved(service).environments;
  if (!prod || !preprod || !int) throw new Error("expected three environments");

  secrets.state.refusing = "new-preprod-key";
  const moved = await user.api("PUT", `/health/services/${service.id}`, {
    ...asSaved(service),
    environments: [
      { ...prod, url: "https://meta.example.org/actuator/health", secret: "new-prod-token" },
      { ...preprod, url: "https://meta-preprod.example.org/actuator/health", secret: "new-preprod-key" },
      int,
    ],
  });

  expect([moved.status, await moved.text()]).toEqual([503, JSON.stringify({ error: "secrets_unavailable", message: "Couldn't save the secrets, so nothing changed. Try again." })]);
  expect(secrets.services()).toEqual(before);
  await checkAll(user);
  expect(sent.map(({ host, headers }) => [host, headers.authorization ?? headers["X-API-Key"] ?? null]).sort()).toEqual([
    ["meta-int.example.com", null],
    ["meta-preprod.example.com", "preprod-key-0123"],
    ["meta.example.com", `Bearer ${token}`],
  ]);
});

test("a person's saves of one service run one after another, so neither signs with a secret the other replaced", async () => {
  const secrets = memorySecrets();
  const { user, sent } = await setup(up, secrets.store);
  const service = await add(user);
  const [prod, preprod, int] = asSaved(service).environments;
  if (!prod || !preprod || !int) throw new Error("expected three environments");
  const edit = (environments: object[]) => user.api("PUT", `/health/services/${service.id}`, { ...asSaved(service), environments });

  // The first save waits on its new preprod key while the second replaces prod's token.
  const held = secrets.hold("new-preprod-key");
  const first = edit([prod, { ...preprod, secret: "new-preprod-key" }, int]);
  await held.reached;
  const second = edit([{ ...prod, secret: "new-prod-token" }, preprod, int]);
  await Bun.sleep(20);
  held.release();

  expect([(await first).status, (await second).status]).toEqual([200, 200]);
  expect(secrets.services().map(([, value]) => value).sort()).toEqual(["new-preprod-key", "new-prod-token"]);
  await checkAll(user);
  expect(sent.map(({ host, headers }) => [host, headers.authorization ?? headers["X-API-Key"] ?? null]).sort()).toEqual([
    ["meta-int.example.com", null],
    ["meta-preprod.example.com", "new-preprod-key"],
    ["meta.example.com", "Bearer new-prod-token"],
  ]);
});

test("a Remove waits for a save of the service before it, and an edit after it finds the service gone", async () => {
  const secrets = memorySecrets();
  const { user } = await setup(up, secrets.store);
  const service = await add(user);
  const saved = asSaved(service);
  const [prod, ...rest] = saved.environments;
  if (!prod) throw new Error("expected prod");

  const held = secrets.hold("new-prod-token");
  const first = user.api("PUT", `/health/services/${service.id}`, { ...saved, environments: [{ ...prod, secret: "new-prod-token" }, ...rest] });
  await held.reached;
  const removed = user.api("DELETE", `/health/services/${service.id}`);
  await Bun.sleep(20);
  const late = user.api("PUT", `/health/services/${service.id}`, saved);
  await Bun.sleep(20);
  held.release();

  expect([(await first).status, (await removed).status, (await late).status]).toEqual([200, 204, 404]);
  expect((await report(user)).services).toEqual([]);
  expect(secrets.services()).toEqual([]);
});

test("a Test waiting for its turn never signs with a secret saved after it was asked: that one is for another URL", async () => {
  const waiting: Array<() => void> = [];
  const { user, sent } = await setup(({ host }) => (host.endsWith(".wide.example.com") ? new Promise((resolve) => waiting.push(() => resolve(up()))) : up()));
  const service = await add(user);
  const prod = asSaved(service).environments[0];
  if (!prod) throw new Error("expected prod");
  const names = ["a", "b", "c", "d"];
  await add(user, { name: "Wide", icon: "api", environments: names.map((name) => ({ name, url: `https://${name}.wide.example.com/health`, auth: { kind: "none" } })) });

  // Every slot is taken, so the Test of prod's saved secret waits.
  const busy = user.api("POST", "/health/services/check");
  await eventually(async () => waiting.length === SERVICE_CONCURRENCY);
  const queued = user.api("POST", "/health/services/test", prod);
  await Bun.sleep(20);
  const moved = { ...prod, url: "https://meta.example.org/actuator/health", secret: "new-prod-token" };
  expect((await user.api("PUT", `/health/services/${service.id}`, { ...asSaved(service), environments: [moved, ...asSaved(service).environments.slice(1)] })).status).toBe(200);
  for (const answer of waiting.splice(0)) answer();

  const result = ServiceResult.parse(await (await queued).json());
  expect(result.status).toBe("unknown");
  expect(result.problem ?? "").toStartWith("Couldn't read this environment's secret");
  await busy;
  expect(sent.filter(({ headers }) => headers.authorization === "Bearer new-prod-token").map(({ host }) => host)).toEqual([]);
});

test("each person sees, edits, checks and tests only their own services", async () => {
  const { user, signIn, sent } = await setup();
  const service = await add(user);
  const prod = service.environments[0];
  if (!prod) throw new Error("expected prod");
  const friend = await signIn({ id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } });

  expect((await report(friend)).services).toEqual([]);
  expect((await friend.api("PUT", `/health/services/${service.id}`, meta)).status).toBe(404);
  expect((await friend.api("POST", `/health/services/${service.id}/check`)).status).toBe(404);
  expect((await friend.api("DELETE", `/health/services/${service.id}`)).status).toBe(404);
  // The owner's saved secret is not theirs to test with, nor their environment to claim.
  expect((await friend.api("POST", "/health/services/test", { id: prod.id, name: "prod", url: prod.url, auth: prod.auth })).status).toBe(404);
  const theirs = await add(friend, ui);
  const claim = await friend.api("PUT", `/health/services/${theirs.id}`, { ...ui, environments: [{ id: prod.id, name: "prod", url: prod.url, auth: prod.auth }] });
  expect(claim.status).toBe(400);

  await checkAll(friend);
  expect(sent.map(({ host }) => host)).toEqual(["ui.example.com"]);
  expect(statuses((await report(user)).services)).toEqual([["Meta", [["prod", null], ["preprod", null], ["int", null]]]]);
  expect((await report(user)).services.map(({ name }) => name)).toEqual(["Meta"]);
});

test("Test checks the unsaved form once, keeping nothing, and uses a saved secret only while it is kept", async () => {
  const { user } = await setup(({ headers }) => (headers.authorization === `Bearer ${token}` ? up() : new Response(null, { status: 401 })));
  const form = { name: "prod", url: "https://meta.example.com/actuator/health", auth: { kind: "bearer" } };
  const test = async (body: object) => {
    const res = await user.api("POST", "/health/services/test", body);
    return res.ok ? ServiceResult.parse(await res.json()) : res.status;
  };

  expect(await test({ ...form, secret: token })).toMatchObject({ status: "ok", code: 200, bodyStatus: "UP" });
  expect(await test({ ...form, secret: "wrong-token" })).toMatchObject({ status: "down", code: 401, problem: "Answered 401: its credential was refused" });
  expect(await test(form)).toBe(400);
  const service = await add(user);
  const prod = service.environments[0];
  expect(await test({ ...form, id: prod?.id })).toMatchObject({ status: "ok" });
  expect(await test({ ...form, id: prod?.id, url: "https://elsewhere.example.com/health" })).toBe(400);
  expect((await report(user)).services[0]?.environments[0]?.recent).toEqual([]);
});

test("a secret never shows in a result, an error or control's log", async () => {
  const secrets = memorySecrets();
  const logged: string[] = [];
  const log = (...args: unknown[]) => void logged.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" "));
  const spies = [spyOn(console, "error").mockImplementation(log), spyOn(console, "log").mockImplementation(log), spyOn(console, "warn").mockImplementation(log)];
  try {
    const { user } = await setup(({ headers }) => Promise.reject(Object.assign(new Error(`refused ${headers.authorization}`), { code: "ECONNREFUSED" })), secrets.store);
    await add(user, { ...meta, environments: meta.environments.slice(0, 1) });

    const refused = await checkAll(user);
    secrets.state.failing = true;
    const unreadable = await checkAll(user);
    const invalid = await user.api("POST", "/health/services", { ...meta, environments: [{ ...meta.environments[0], secret: `${token}\nX-Injected: 1` }] });

    expect(refused[0]?.environments[0]?.latest?.problem).toBe("Connection refused");
    expect(unreadable[0]?.environments[0]?.latest?.status).toBe("unknown");
    expect(unreadable[0]?.environments[0]?.latest?.problem).toStartWith("Couldn't read this environment's secret");
    expect(invalid.status).toBe(400);
    expect(JSON.stringify([refused, unreadable, await invalid.text(), logged])).not.toContain(token);
    expect(logged.join("\n")).toContain("could not read its secret");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test("at most SERVICE_CONCURRENCY checks of a person's services run at once", async () => {
  let active = 0;
  let most = 0;
  const waiting: Array<() => void> = [];
  const { user } = await setup(() => {
    most = Math.max(most, ++active);
    return new Promise((resolve) => waiting.push(() => (active--, resolve(up()))));
  });
  const names = ["a", "b", "c", "d", "e", "f"];
  await add(user, { name: "Wide", icon: "api", environments: names.map((name) => ({ name, url: `https://${name}.example.com/health`, auth: { kind: "none" } })) });

  const checked = checkAll(user);
  await eventually(async () => waiting.length === SERVICE_CONCURRENCY);
  await Bun.sleep(20);
  expect(waiting.length).toBe(SERVICE_CONCURRENCY);
  for (let answered = 0; answered < names.length; answered++) {
    await eventually(async () => waiting.length > 0);
    waiting.shift()?.();
  }

  expect(statuses(await checked)).toEqual([["Wide", names.map((name) => [name, "ok"])]]);
  expect(most).toBe(SERVICE_CONCURRENCY);
});

test("a check still running is aborted and dropped when its service is saved again or removed, or control stops", async () => {
  // Each check answers only once aborted, with a result that must not be kept.
  const { user, sent, stopControl } = await setup(({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(Response.json({ status: "DOWN" }, { status: 503 })))));
  const service = await add(user, ui);

  const edited = checkAll(user);
  await eventually(async () => sent.length === 1);
  await user.api("PUT", `/health/services/${service.id}`, asSaved(service));
  expect(sent[0]?.signal.aborted).toBe(true);
  expect((await edited)[0]?.environments[0]?.recent).toEqual([]);

  const removed = checkAll(user);
  await eventually(async () => sent.length === 2);
  await user.api("DELETE", `/health/services/${service.id}`);
  expect(sent[1]?.signal.aborted).toBe(true);
  expect(await removed).toEqual([]);

  await add(user, ui);
  void checkAll(user).catch(() => {});
  await eventually(async () => sent.length === 3);
  stopControl();
  expect(sent[2]?.signal.aborted).toBe(true);
});
