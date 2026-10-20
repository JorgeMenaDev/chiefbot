import { worstStatus, type HealthItem } from "@chiefbot/contracts";
import { z } from "zod";
import { call, combine, failure, instanceOrigin, notChecked, plural, type Probe } from "./probe.ts";

// At most this many problems are read; the summary says "or more" at the limit.
const limit = 100;

// The open Davis problems, newest first: what Dynatrace's Problems app lists. A
// platform token reads them from Grail with the scopes the connection's setup
// asks for (storage:events:read, storage:buckets:read), so no classic API token.
export const problemsQuery = `fetch dt.davis.problems, from:-24h
| filter event.status == "ACTIVE"
| filterOut dt.davis.is_duplicate == true
| sort event.start desc
| fields id = display_id, title = event.name, category = event.category, affected = smartscape.affected_entities
| limit ${limit}`;

const Problem = z.object({
  id: z.string().nullish(),
  title: z.string().nullish(),
  category: z.string().nullish(),
  affected: z.array(z.object({ name: z.string().nullish() }).nullable()).nullish(),
});

// A Grail query's state, and its records once it SUCCEEDED (query:execute and
// query:poll); execute also names the query for polling while it runs.
const QueryResponse = z.object({
  state: z.string(),
  requestToken: z.string().optional(),
  result: z.object({ records: z.array(z.unknown()) }).optional(),
});
const running = (state: string) => state === "NOT_STARTED" || state === "RUNNING";

// Dynatrace's probe: open problems through the Grail query API with the platform
// token. An AVAILABILITY problem is down, any other open one degraded.
export const dynatraceProbe: Probe = async ({ environment = "", token = "" }, signal) => {
  const origin = instanceOrigin(environment);
  if (!origin) return combine([notChecked("Not checked", "Couldn't check Dynatrace", "The environment URL must be https:// and the host only, like https://abc12345.apps.dynatrace.com.")]);
  const api = `${origin}/platform/storage/query/v1`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  let records: unknown[];
  try {
    let res = await call(`${api}/query:execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: problemsQuery, requestTimeoutMilliseconds: 10_000, maxResultRecords: limit }),
      signal,
    });
    let query = QueryResponse.safeParse(res.body);
    // Still running after the long wait (202): poll it until it ends, or `signal` gives up.
    const requestToken = query.success ? query.data.requestToken : undefined;
    while (requestToken && res.status < 300 && query.success && running(query.data.state)) {
      res = await call(`${api}/query:poll?request-token=${encodeURIComponent(requestToken)}&request-timeout-milliseconds=10000`, { headers, signal });
      query = QueryResponse.safeParse(res.body);
    }
    if (res.status === 401 || res.status === 403) {
      return combine([notChecked("Not checked", "Dynatrace refused the token", `Dynatrace answered ${res.status}. The platform token needs the storage:events:read and storage:buckets:read scopes, and its user must be allowed to read problems.`)]);
    }
    if (res.status !== 200 || !query.success || query.data.state !== "SUCCEEDED" || !query.data.result) {
      return combine([notChecked("Not checked", "Couldn't read Dynatrace's problems", `The query API answered ${res.status}${query.success ? ` (${query.data.state})` : ""}. Check the environment URL is the .apps.dynatrace.com one.`)]);
    }
    records = query.data.result.records;
  } catch (error) {
    return combine([notChecked("Not checked", "Couldn't reach Dynatrace", failure(error))]);
  }
  const items: HealthItem[] = records.flatMap((record) => {
    const problem = Problem.safeParse(record);
    if (!problem.success) return [];
    const { id, title, category, affected } = problem.data;
    const names = (affected ?? []).flatMap((entity) => (entity?.name ? [entity.name] : []));
    return [
      {
        status: category === "AVAILABILITY" ? "down" : "degraded",
        title: title || "Open problem",
        detail: [id, category?.toLowerCase().replaceAll("_", " "), names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "")].filter(Boolean).join(" · "),
      },
    ];
  });
  const count = records.length >= limit ? `${limit} or more open problems` : plural(records.length, "open problem");
  return combine([{ status: worstStatus(items.map(({ status }) => status)), phrase: records.length === 0 ? "No open problems" : count, items }]);
};
