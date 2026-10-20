import { expect, test } from "bun:test";
import { isIP } from "node:net";
import { SERVICE_PROBLEM_MAX, ServiceResult } from "@chiefbot/contracts";
import { fakeClock } from "@chiefbot/worker/clock";
import { checkEnvironment, SERVICE_TIMEOUT_MS, type Net } from "./serviceCheck.ts";

const token = "s3cr3t-token-value";
const url = "https://meta.example.com/actuator/health";

type Call = { url: string; init: BunFetchRequestInit };

// A fake network: `answer` stands in for the service, and `dns` for the resolver.
// Nothing leaves the process.
function fakeNet(answer: (call: Call) => Response | Promise<Response>, dns: Record<string, string[]> = { "meta.example.com": ["203.0.113.10"] }) {
  const calls: Call[] = [];
  const net: Net = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return answer({ url, init });
    },
    lookup: async (hostname) => {
      const addresses = dns[hostname];
      if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
      return addresses.map((address) => ({ address, family: isIP(address) }));
    },
  };
  return { net, calls };
}

// Checks `target` (default: the https URL with a bearer token) on a fake clock.
function check(net: Net, target: Partial<Parameters<typeof checkEnvironment>[0]> = {}, time = fakeClock(0)) {
  return checkEnvironment({ url, auth: { kind: "bearer" }, secret: token, ...target }, { net, clock: time.clock, stop: new AbortController().signal });
}

test("a 2xx within 2 s is healthy, with the body's status, sent once to the address control resolved and checked", async () => {
  const { net, calls } = fakeNet(() => Response.json({ status: "UP", components: { db: { status: "UP", details: { password: "x" } } } }));

  expect(await check(net)).toEqual({ status: "ok", code: 200, bodyStatus: "UP", latencyMs: 0, problem: null });
  const [call] = calls;
  // Pinned to the address checked, so DNS cannot answer differently for the request itself.
  expect(call?.url).toBe("https://203.0.113.10/actuator/health");
  expect(call?.init.headers).toEqual({ host: "meta.example.com", authorization: `Bearer ${token}` });
  expect(call?.init.tls?.serverName).toBe("meta.example.com");
  expect(call?.init.redirect).toBe("manual");
});

test("a plain-text 200 is healthy with no body status, and a header credential goes as its own header", async () => {
  const { net, calls } = fakeNet(() => new Response("OK"), { localhost: ["::1", "127.0.0.1"] });

  const result = await check(net, { url: "http://localhost:7471/prod/ui/health", auth: { kind: "header", header: "X-API-Key" }, secret: "key-123" });

  expect(result).toEqual({ status: "ok", code: 200, bodyStatus: null, latencyMs: 0, problem: null });
  expect(calls[0]?.url).toBe("http://127.0.0.1:7471/prod/ui/health");
  expect(calls[0]?.init.headers).toEqual({ host: "localhost:7471", "X-API-Key": "key-123" });
  expect(calls[0]?.init.tls).toBeUndefined();
});

test("a 2xx slower than 2 s is degraded, as Slow", async () => {
  const time = fakeClock(0);
  const { net } = fakeNet(() => {
    time.advance(2500);
    return Response.json({ status: "UP" });
  });

  expect(await check(net, {}, time)).toEqual({ status: "degraded", code: 200, bodyStatus: "UP", latencyMs: 2500, problem: "Answered in 2.5 s, over the 2 s limit" });
});

test("a 5xx is down, with the body's status; Actuator's DOWN or OUT_OF_SERVICE is down even with a 200", async () => {
  const answers = [Response.json({ status: "DOWN" }, { status: 503 }), Response.json({ status: "DOWN" }), Response.json({ status: "OUT_OF_SERVICE" }), new Response("boom", { status: 500 })];
  const { net } = fakeNet(() => answers.shift() ?? new Response(null, { status: 500 }));

  expect(await check(net)).toEqual({ status: "down", code: 503, bodyStatus: "DOWN", latencyMs: 0, problem: "Answered 503 and reports DOWN" });
  expect(await check(net)).toEqual({ status: "down", code: 200, bodyStatus: "DOWN", latencyMs: 0, problem: "Answered 200 but reports DOWN" });
  expect((await check(net)).status).toBe("down");
  expect(await check(net)).toEqual({ status: "down", code: 500, bodyStatus: null, latencyMs: 0, problem: "Answered 500" });
});

test("a 401 says whether a credential was sent", async () => {
  const { net } = fakeNet(() => new Response(null, { status: 401 }));

  expect((await check(net)).problem).toBe("Answered 401: its credential was refused");
  expect((await check(net, { auth: { kind: "none" }, secret: null })).problem).toBe("Answered 401: it needs authentication");
});

test("no answer in 10 s is down, and the request is aborted", async () => {
  const time = fakeClock(0);
  const signals: AbortSignal[] = [];
  const { net } = fakeNet(
    ({ init }) =>
      new Promise((_, reject) => {
        if (init.signal) signals.push(init.signal);
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );

  const result = check(net, {}, time);
  await Bun.sleep(0);
  time.advance(SERVICE_TIMEOUT_MS);

  expect(await result).toEqual({ status: "down", code: null, bodyStatus: null, latencyMs: null, problem: "No answer within 10 s" });
  expect(signals[0]?.aborted).toBe(true);
});

test("a refused connection or a name that does not resolve is down", async () => {
  const refused = fakeNet(() => Promise.reject(Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" })));
  const unresolved = fakeNet(() => new Response("OK"), {});

  expect(await check(refused.net)).toEqual({ status: "down", code: null, bodyStatus: null, latencyMs: null, problem: "Connection refused" });
  expect((await check(unresolved.net)).problem).toBe("Couldn't find meta.example.com");
  expect(unresolved.calls).toEqual([]);
});

test("a redirect is not followed: it is down, naming only where it points", async () => {
  const { net, calls } = fakeNet(() => new Response(null, { status: 302, headers: { location: "https://login.example.org/sso?next=/health" } }));

  expect(await check(net)).toEqual({ status: "down", code: 302, bodyStatus: null, latencyMs: 0, problem: "Redirects to login.example.org, which is not followed" });
  expect(calls).toHaveLength(1);
});

test("a problem naming a long host is cut to the length a result may have", async () => {
  const far = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(63)}.example.org`;
  const { net } = fakeNet(() => new Response(null, { status: 302, headers: { location: `https://${far}/` } }));

  const { problem } = ServiceResult.parse(await check(net));
  expect(problem).toHaveLength(SERVICE_PROBLEM_MAX);
  expect(problem ?? "").toStartWith(`Redirects to ${"a".repeat(63)}.`);
  expect(problem ?? "").toEndWith("…");
});

test("a cloud metadata address is never asked, by name or by what a name resolves to", async () => {
  const { net, calls } = fakeNet(() => new Response("OK"), {
    "meta.example.com": ["203.0.113.10", "169.254.169.254"],
    "rebind.example.com": ["fd00:ec2::254"],
    "mapped.example.com": ["::ffff:169.254.169.254"],
  });
  const targets = [
    url,
    "http://rebind.example.com/latest/meta-data",
    "http://mapped.example.com/",
    "http://169.254.169.254/computeMetadata/v1/",
    "http://[fd00:ec2::254]/latest/meta-data",
    "http://metadata.google.internal./computeMetadata/v1/",
  ];

  for (const target of targets) {
    const result = await check(net, { url: target, auth: { kind: "header", header: "Metadata-Flavor" }, secret: "Google" });
    expect(result.status).toBe("unknown");
    expect(result.problem).toMatch(/^Not checked: .+ is a cloud metadata address$/);
  }
  expect(calls).toEqual([]);
});

test("the secret is never in a result, whatever the service echoes", async () => {
  const echoes = [
    () => Response.json({ status: token }),
    () => new Response(null, { status: 302, headers: { location: `https://${token}.example.org/` } }),
    () => Promise.reject(Object.assign(new Error(`bad header Bearer ${token}`), { code: token })),
    () => new Response(null, { status: 401, statusText: token }),
  ];
  const { net } = fakeNet(() => (echoes.shift() ?? echoes[0])?.() ?? new Response(null));

  for (let index = 0; index < 4; index++) expect(JSON.stringify(await check(net))).not.toContain(token);
});
