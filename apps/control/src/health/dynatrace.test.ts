import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { dynatraceProbe, problemsQuery } from "./dynatrace.ts";

const stops: Array<() => void> = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

const token = "dt0s16.SAMPLE.secret";
const signal = () => AbortSignal.timeout(5000);

// A fake Dynatrace Grail query API that takes only `token`. Its query is still
// running when started, so the probe has to poll for the records.
function fakeDynatrace(records: object[], status = 200) {
  const queries: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname, searchParams } = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      if (status !== 200) return Response.json({ error: { code: status, message: "Forbidden" } }, { status });
      if (req.method === "POST" && pathname === "/platform/storage/query/v1/query:execute") {
        queries.push(z.object({ query: z.string() }).parse(await req.json()).query);
        return Response.json({ state: "RUNNING", requestToken: "req-1", ttlSeconds: 60 }, { status: 202 });
      }
      if (pathname === "/platform/storage/query/v1/query:poll" && searchParams.get("request-token") === "req-1") {
        return Response.json({ state: "SUCCEEDED", progress: 100, result: { records, types: [], metadata: {} } });
      }
      return new Response(null, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return { environment: server.url.origin, queries };
}

test("open problems from Grail: an availability one is down, the rest degraded, with their entities", async () => {
  const { environment, queries } = fakeDynatrace([
    { id: "P-2610201", title: "Service unavailable", category: "AVAILABILITY", affected: [{ id: "SERVICE-1", type: "service", name: "checkout" }] },
    { id: "P-2610202", title: "Response time degradation", category: "SLOWDOWN", affected: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }] },
  ]);

  expect(await dynatraceProbe({ environment, token }, signal())).toEqual({
    status: "down",
    summary: "2 open problems",
    items: [
      { status: "down", title: "Service unavailable", detail: "P-2610201 · availability · checkout" },
      { status: "degraded", title: "Response time degradation", detail: "P-2610202 · slowdown · a, b, c and 1 more" },
    ],
  });
  expect(queries).toEqual([problemsQuery]);
});

test("no open problems is ok; a refused token or a bad URL is unknown with the reason", async () => {
  const healthy = fakeDynatrace([]);
  const refused = fakeDynatrace([], 403);

  expect(await dynatraceProbe({ environment: healthy.environment, token }, signal())).toEqual({ status: "ok", summary: "No open problems", items: [] });
  const forbidden = await dynatraceProbe({ environment: refused.environment, token }, signal());
  expect([forbidden.status, forbidden.items[0]?.title]).toEqual(["unknown", "Dynatrace refused the token"]);
  expect(forbidden.items[0]?.detail).toContain("storage:events:read");
  const plain = await dynatraceProbe({ environment: "http://abc12345.apps.dynatrace.com", token }, signal());
  expect([plain.status, plain.items[0]?.detail]).toEqual(["unknown", "The environment URL must be https:// and the host only, like https://abc12345.apps.dynatrace.com."]);
  expect(JSON.stringify([forbidden, plain])).not.toContain(token);
});
