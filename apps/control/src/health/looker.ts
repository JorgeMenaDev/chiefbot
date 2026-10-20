import type { HealthItem } from "@chiefbot/contracts";
import { z } from "zod";
import { call, combine, failure, instanceOrigin, notChecked, plural, type Part, type Probe } from "./probe.ts";

// The two System Activity queries (Looker's own database: they build no derived
// tables), as inline queries: query errors in the last hour, grouped by message,
// and failed schedule deliveries in the last 24 hours.
export const errorsQuery = {
  model: "system__activity",
  view: "history",
  fields: ["history.message", "query.model", "query.view", "history.query_run_count"],
  filters: { "history.status": "error", "history.created_time": "1 hours" },
  sorts: ["history.query_run_count desc"],
  limit: "20",
};
export const failedSchedulesQuery = {
  model: "system__activity",
  view: "scheduled_plan",
  fields: ["scheduled_plan.name", "scheduled_job.status_detail", "scheduled_job.created_time"],
  filters: { "scheduled_job.status": "failure", "scheduled_job.created_time": "24 hours" },
  sorts: ["scheduled_job.created_time desc"],
  limit: "100",
};

const Rows = z.array(z.record(z.string(), z.unknown()));
const text = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

// Looker's probe, with the Looker CLI's rules (connections/looker/looker.ts):
// the instance URL is an https origin, redirects are refused, and neither the
// secret nor the session token ever lands in a result. Looker answering 5xx
// on /versions is down; not answering at all is unknown (control may be the one
// cut off). Query errors and failed schedules are degraded.
export const lookerProbe: Probe = async ({ url = "", clientid = "", secret = "" }, signal) => {
  const origin = instanceOrigin(url);
  if (!origin) return combine([notChecked("Not checked", "Couldn't check Looker", "The instance URL must be https:// and the host only, like https://mycompany.cloud.looker.com.")]);
  const api = `${origin}/api/4.0`;
  try {
    const versions = await call(`${api}/versions`, { signal });
    if (versions.status >= 500) return combine([{ status: "down", phrase: "Not answering", items: [{ status: "down", title: "Looker is not answering", detail: `${origin} answered ${versions.status}.` }] }]);
    if (versions.status !== 200) return combine([notChecked("Not checked", "Couldn't reach Looker's API", `${origin}/api/4.0/versions answered ${versions.status}. Check the instance URL (and its API port, if your admin uses one).`)]);
    const login = await call(`${api}/login`, { method: "POST", body: new URLSearchParams({ client_id: clientid, client_secret: secret }), signal });
    const session = z.object({ access_token: z.string().regex(/^[\w.~+/=-]+$/) }).safeParse(login.body);
    if (login.status !== 200 || !session.success) return combine([notChecked("Reachable, not signed in", "Looker refused the API key", `Signing in answered ${login.status}. Check the client ID and secret.`)]);
    const run = async (query: object) => {
      const res = await call(`${api}/queries/run/json`, {
        method: "POST",
        headers: { authorization: `token ${session.data.access_token}`, "content-type": "application/json" },
        body: JSON.stringify(query),
        signal,
      });
      const rows = Rows.safeParse(res.body);
      return res.status === 200 && rows.success ? rows.data : res.status;
    };
    const [errors, schedules] = await Promise.all([run(errorsQuery), run(failedSchedulesQuery)]);
    return combine([{ status: "ok", phrase: "Reachable", items: [] }, queryErrors(errors), failedSchedules(schedules)]);
  } catch (error) {
    return combine([notChecked("Not checked", "Couldn't reach Looker", failure(error))]);
  }
};

// A System Activity query Looker refused: the API user's role lacks see_system_activity.
const noActivity = (phrase: string, what: string, status: number) =>
  notChecked(phrase, `Couldn't read ${what}`, `System Activity answered ${status}. The API user's role needs see_system_activity.`);

function queryErrors(rows: Array<Record<string, unknown>> | number): Part {
  if (typeof rows === "number") return noActivity("Query errors not checked", "query errors", rows);
  const items: HealthItem[] = rows.map((row) => {
    const count = Number(row["history.query_run_count"]) || 1;
    return {
      status: "degraded",
      title: text(row["history.message"]) || "A query failed",
      detail: `${text(row["query.model"])}/${text(row["query.view"])} · ${plural(count, "time")} in the last hour`,
    };
  });
  const total = rows.reduce((sum, row) => sum + (Number(row["history.query_run_count"]) || 1), 0);
  return { status: items.length > 0 ? "degraded" : "ok", phrase: total > 0 ? `${plural(total, "query error")} in the last hour` : "No query errors in the last hour", items };
}

// Failed deliveries, one item per schedule with its latest error.
function failedSchedules(rows: Array<Record<string, unknown>> | number): Part {
  if (typeof rows === "number") return noActivity("Schedules not checked", "schedule deliveries", rows);
  const byPlan = new Map<string, { detail: string; count: number }>();
  for (const row of rows) {
    const name = text(row["scheduled_plan.name"]) || "A schedule";
    const seen = byPlan.get(name);
    byPlan.set(name, { detail: seen?.detail ?? text(row["scheduled_job.status_detail"]), count: (seen?.count ?? 0) + 1 });
  }
  const items: HealthItem[] = [...byPlan].map(([name, { detail, count }]) => ({
    status: "degraded",
    title: `Schedule "${name}" failed to deliver`,
    detail: [detail, `${plural(count, "time")} in the last 24 hours`].filter(Boolean).join(" · "),
  }));
  return { status: items.length > 0 ? "degraded" : "ok", phrase: rows.length > 0 ? `${plural(rows.length, "failed delivery", "failed deliveries")} in 24 hours` : "No failed schedules in 24 hours", items };
}
