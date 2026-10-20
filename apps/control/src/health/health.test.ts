import { afterEach, expect, test } from "bun:test";
import { HealthReport, type ProbeResult } from "@chiefbot/contracts";
import { fakeClock } from "@chiefbot/worker/clock";
import { loadConnections, repoConnections } from "../connections/catalog.ts";
import { cleanUp, eventually, hour, startTestControl, type TestUser } from "../testControl.ts";
import { googleUrls } from "./gcloud.ts";
import { defaultProbes, HEALTH_CONCURRENCY, HEALTH_TICK_MS } from "./health.ts";
import type { Probe } from "./probe.ts";

afterEach(cleanUp);

const minute = 60_000;
const looker = { url: "https://looker.example.com", clientid: "client-id", secret: "client-secret" };
const ok: ProbeResult = { status: "ok", summary: "Reachable", items: [] };

// Control on a fake clock whose Looker probe answers `answer` (default ok) and
// records the fields it got.
async function setup(answer: Probe = async () => ok) {
  const time = fakeClock(Date.UTC(2026, 9, 20, 9));
  const seen: Array<Record<string, string>> = [];
  const probe: Probe = (fields, signal) => (seen.push(fields), answer(fields, signal));
  const control = await startTestControl({ clock: time.clock, probes: { looker: probe } });
  return { ...control, time, seen };
}

const report = async ({ api }: TestUser, refresh = false) => HealthReport.parse(await (await api(refresh ? "POST" : "GET", refresh ? "/health/refresh" : "/health")).json());
const checks = async (user: TestUser) => (await report(user)).connections.flatMap(({ history }) => history.map(({ at }) => at));

test("the repo's Google Cloud, Dynatrace and Looker connections have probes", () => {
  const probed = loadConnections(repoConnections).filter(({ name }) => name in defaultProbes(googleUrls));
  expect(probed.map(({ title }) => title)).toEqual(["Dynatrace", "Google Cloud", "Looker"]);
});

test("control checks a connection with a probe within a minute of it going on, then every 5 minutes and on Refresh, with its saved fields", async () => {
  const { user, time, seen, signIn } = await setup();
  const start = time.clock.now();
  await user.api("PUT", "/connections/looker", { fields: looker });
  await user.api("PUT", "/connections/jira", { fields: { site: "example.atlassian.net", email: "octo@example.com", token: "jira-token" } });

  expect(await report(user)).toEqual({ checkable: ["Looker"], connections: [{ name: "looker", title: "Looker", latest: null, history: [] }] });
  time.advance(HEALTH_TICK_MS);
  await eventually(async () => (await checks(user)).length === 1);
  time.advance(4 * minute);
  await Bun.sleep(20);
  expect(await checks(user)).toEqual([start + minute]);
  time.advance(minute);
  await eventually(async () => (await checks(user)).length === 2);
  const refreshed = await report(user, true);

  expect(refreshed.connections[0]?.history.map(({ at }) => at)).toEqual([start + minute, start + 6 * minute, start + 6 * minute]);
  expect(refreshed.connections[0]?.latest).toEqual({ ...ok, at: start + 6 * minute });
  // The probe got every saved field, the secret too; Jira has no probe.
  expect(seen).toEqual([looker, looker, looker]);
  // Another person sees only their own.
  expect((await report(await signIn({ id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } }))).connections).toEqual([]);
});

test("a probe that throws or answers junk is unknown with the reason, never ok", async () => {
  const answers: Array<() => ProbeResult> = [
    () => {
      throw new Error("socket hang up");
    },
    () => ({ status: "ok", summary: "", items: [] }),
  ];
  const { user } = await setup(async () => answers.shift()?.() ?? ok);
  await user.api("PUT", "/connections/looker", { fields: looker });

  const thrown = (await report(user, true)).connections[0]?.latest;
  const junk = (await report(user, true)).connections[0]?.latest;

  expect([thrown?.status, thrown?.summary]).toEqual(["unknown", "The check failed: socket hang up"]);
  expect(junk?.status).toBe("unknown");
  expect(junk?.summary).toStartWith("The check failed: ");
});

test("the screen shows the last 24 hours of checks, and none once the connection is turned off", async () => {
  const { user, time } = await setup();
  const start = time.clock.now();
  await user.api("PUT", "/connections/looker", { fields: looker });
  await report(user, true);
  time.advance(24 * hour + minute);
  await report(user, true);

  const kept = await checks(user);
  expect(kept).not.toContain(start);
  expect(kept.every((at) => at >= time.clock.now() - 24 * hour)).toBe(true);
  await user.api("DELETE", "/connections/looker");
  await user.api("PUT", "/connections/looker", { fields: looker });
  expect(await checks(user)).toEqual([]);
});

test("a check still running is aborted and dropped when its connection is saved again, turned off, or control stops", async () => {
  const signals: AbortSignal[] = [];
  const slow = { ...looker, url: "https://slow.example.com" };
  // The slow instance answers only once aborted, with a result that must not be kept.
  const { user, stopControl } = await setup((fields, signal) => {
    if (fields.url !== slow.url) return Promise.resolve(ok);
    signals.push(signal);
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "down", summary: "Stale", items: [] })));
  });

  await user.api("PUT", "/connections/looker", { fields: slow });
  const edited = report(user, true);
  await eventually(async () => signals.length === 1);
  await user.api("PUT", "/connections/looker", { fields: looker });
  expect(signals[0]?.aborted).toBe(true);
  expect((await edited).connections[0]?.history).toEqual([]);
  // The new fields' own check is the only one kept.
  expect((await report(user, true)).connections[0]?.history.map(({ summary }) => summary)).toEqual(["Reachable"]);

  await user.api("PUT", "/connections/looker", { fields: slow });
  const turnedOff = report(user, true);
  await eventually(async () => signals.length === 2);
  await user.api("DELETE", "/connections/looker");
  expect(signals[1]?.aborted).toBe(true);
  expect((await turnedOff).connections).toEqual([]);

  await user.api("PUT", "/connections/looker", { fields: slow });
  void report(user, true).catch(() => {});
  await eventually(async () => signals.length === 3);
  stopControl();
  expect(signals[2]?.aborted).toBe(true);
});

test("scheduled checks run at most HEALTH_CONCURRENCY at a time, so a restart does not fire every probe at once", async () => {
  let active = 0;
  let most = 0;
  const waiting: Array<() => void> = [];
  const { user, time, signIn } = await setup(() => {
    most = Math.max(most, ++active);
    return new Promise((resolve) => waiting.push(() => (active--, resolve(ok))));
  });
  const others = await Promise.all([1, 2, 3, 4, 5].map((n) => signIn({ id: 6100 + n, login: `octo-${n}`, copilot: { plan: "individual", sku: "free_limited_copilot" } })));
  const people = [user, ...others];
  for (const person of people) await person.api("PUT", "/connections/looker", { fields: looker });

  time.advance(HEALTH_TICK_MS);
  await eventually(async () => waiting.length === HEALTH_CONCURRENCY);
  await Bun.sleep(20);
  expect(waiting.length).toBe(HEALTH_CONCURRENCY);
  for (let answered = 0; answered < people.length; answered++) {
    await eventually(async () => waiting.length > 0);
    waiting.shift()?.();
  }

  await eventually(async () => (await Promise.all(people.map(checks))).every((each) => each.length === 1));
  expect(most).toBe(HEALTH_CONCURRENCY);
});
