import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { errorsQuery, failedSchedulesQuery, lookerProbe } from "./looker.ts";

const stops: Array<() => void> = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

const secret = "aBcD1234eFgH5678iJkL9012";
const signal = () => AbortSignal.timeout(5000);

type Answers = { versions?: number; redirect?: boolean; activity?: number; errors?: object[]; schedules?: object[]; key?: string };

// A fake Looker API 4.0: /versions, /login with the key's ID and secret, and
// inline System Activity queries with the session token it handed out.
function fakeLooker({ versions = 200, redirect = false, activity = 200, errors = [], schedules = [], key = secret }: Answers = {}) {
  const queries: object[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/4.0/versions") {
        if (redirect) return Response.redirect("https://elsewhere.example/api/4.0/versions", 302);
        return Response.json({ looker_release_version: "26.18" }, { status: versions });
      }
      if (pathname === "/api/4.0/login") {
        const form = new URLSearchParams(await req.text());
        const valid = form.get("client_id") === "client-id" && form.get("client_secret") === key;
        return valid ? Response.json({ access_token: "session-token", token_type: "Bearer", expires_in: 3600 }) : Response.json({ message: "Not found" }, { status: 404 });
      }
      if (pathname === "/api/4.0/queries/run/json" && req.headers.get("authorization") === "token session-token") {
        const query = z.looseObject({ view: z.string() }).parse(await req.json());
        queries.push(query);
        if (activity !== 200) return Response.json({ message: "Not found" }, { status: activity });
        return Response.json(query.view === "history" ? errors : schedules);
      }
      return new Response(null, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return { fields: { url: server.url.origin, clientid: "client-id", secret: key }, queries };
}

test("Looker answering with query errors and failed schedules is degraded, one row per error and per schedule", async () => {
  const { fields, queries } = fakeLooker({
    errors: [{ "history.message": "Table 'sales.orders' was not found", "query.model": "ecommerce", "query.view": "orders", "history.query_run_count": 12 }],
    schedules: [
      { "scheduled_plan.name": "Daily revenue", "scheduled_job.status_detail": "SMTP timeout", "scheduled_job.created_time": "2026-10-20 08:00:00" },
      { "scheduled_plan.name": "Daily revenue", "scheduled_job.status_detail": "SMTP refused", "scheduled_job.created_time": "2026-10-19 08:00:00" },
    ],
  });

  expect(await lookerProbe(fields, signal())).toEqual({
    status: "degraded",
    summary: "Reachable · 12 query errors in the last hour · 2 failed deliveries in 24 hours",
    items: [
      { status: "degraded", title: "Table 'sales.orders' was not found", detail: "ecommerce/orders · 12 times in the last hour" },
      { status: "degraded", title: 'Schedule "Daily revenue" failed to deliver', detail: "SMTP timeout · 2 times in the last 24 hours" },
    ],
  });
  expect(queries).toEqual([errorsQuery, failedSchedulesQuery]);
});

test("a quiet Looker is ok; answering 5xx is down; a refused key, no System Activity access or a redirect is unknown", async () => {
  const quiet = await lookerProbe(fakeLooker().fields, signal());
  const failing = await lookerProbe(fakeLooker({ versions: 503 }).fields, signal());
  const wrongSecret = await lookerProbe({ ...fakeLooker().fields, secret: "wrong" }, signal());
  const noActivity = await lookerProbe(fakeLooker({ activity: 403 }).fields, signal());
  const moved = await lookerProbe(fakeLooker({ redirect: true }).fields, signal());

  expect(quiet).toEqual({ status: "ok", summary: "Reachable · No query errors in the last hour · No failed schedules in 24 hours", items: [] });
  expect([failing.status, failing.items[0]?.title]).toEqual(["down", "Looker is not answering"]);
  expect([wrongSecret.status, wrongSecret.items[0]?.title]).toEqual(["unknown", "Looker refused the API key"]);
  expect([noActivity.status, noActivity.items.map(({ title }) => title)]).toEqual(["unknown", ["Couldn't read query errors", "Couldn't read schedule deliveries"]]);
  expect(noActivity.items[0]?.detail).toContain("see_system_activity");
  expect([moved.status, moved.items[0]?.detail]).toEqual(["unknown", expect.stringContaining("answered 302")]);
  expect(JSON.stringify([quiet, failing, wrongSecret, noActivity, moved])).not.toMatch(new RegExp(`${secret}|session-token`));
});

test("the secret and the session token never reach a result, in any form Looker echoes them", async () => {
  const key = 'k3y+/&"=ü x';
  const forms = (value: string) => [value, encodeURIComponent(value), new URLSearchParams({ x: value }).toString().slice(2), JSON.stringify(value).slice(1, -1)];
  const echo = [...forms(key), ...forms("session-token")].join(" | ");
  const { fields } = fakeLooker({ key, errors: [{ "history.message": `Bad query: ${echo}` }], schedules: [{ "scheduled_plan.name": echo, "scheduled_job.status_detail": echo }] });

  const { summary, items } = await lookerProbe(fields, signal());

  const shown = [summary, ...items.flatMap(({ title, detail = "" }) => [title, detail])].join("\n");
  for (const form of [...forms(key), "session-token"]) expect(shown).not.toContain(form);
  expect(items.map(({ title }) => title)).toEqual(["Bad query: [redacted] | [redacted] | [redacted] | [redacted] | [redacted] | [redacted] | [redacted] | [redacted]", expect.stringContaining("[redacted]")]);
});
