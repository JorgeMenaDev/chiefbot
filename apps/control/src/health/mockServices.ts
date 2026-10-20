import { z } from "zod";

// Three services a team might run, for trying services on Health by hand
// (README, "Manual check: your own services on Health"). On one port of
// 127.0.0.1, each answers in prod, preprod and int, under a path prefix:
//   /<env>/ui/health              200 OK, plain text
//   /<env>/meta/actuator/health   200 {"status":"UP"}, as Spring Boot Actuator answers
//   /<env>/auth/actuator/health   the same, only with Authorization: Bearer <token>; 401 without
// Each service's environment is up, down (503, with {"status":"DOWN"} for Meta
// and Auth) or slow (its answer after SLOW_MS), independently:
//   POST /_mock/<service>/<env>/<up|down|slow>   flips one; GET /_mock lists them all.
//
//   bun run mock:services                         starts it: MOCK_SERVICES_PORT (default 7471),
//                                                 MOCK_SERVICES_TOKEN (default mock-token)
//   bun run mock:services set meta preprod down   flips one on the running mock

export const MOCK_SERVICES = ["ui", "meta", "auth"] as const;
export const MOCK_ENVIRONMENTS = ["prod", "preprod", "int"] as const;
const SLOW_MS = 2500;

const MockService = z.enum(MOCK_SERVICES);
const MockEnvironment = z.enum(MOCK_ENVIRONMENTS);
const MockState = z.enum(["up", "down", "slow"]);
type MockState = z.infer<typeof MockState>;

export function startMockServices({ port = 7471, token = "mock-token", slowMs = SLOW_MS }: { port?: number; token?: string; slowMs?: number } = {}) {
  const states = new Map<string, MockState>();
  const stateOf = (service: string, env: string) => states.get(`${service}/${env}`) ?? "up";
  const table = () => Object.fromEntries(MOCK_SERVICES.map((service) => [service, Object.fromEntries(MOCK_ENVIRONMENTS.map((env) => [env, stateOf(service, env)]))]));

  async function answer(service: z.infer<typeof MockService>, req: Bun.BunRequest<"/:env/ui/health">) {
    const env = MockEnvironment.safeParse(req.params.env);
    if (!env.success) return new Response("Not found", { status: 404 });
    if (service === "auth" && req.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    const state = stateOf(service, env.data);
    if (state === "slow") await Bun.sleep(slowMs);
    if (state === "down") return service === "ui" ? new Response("Service Unavailable", { status: 503 }) : Response.json({ status: "DOWN" }, { status: 503 });
    return service === "ui" ? new Response("OK") : Response.json({ status: "UP" });
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    routes: {
      "/_mock": { GET: () => Response.json(table()) },
      "/_mock/:service/:env/:state": {
        POST: (req) => {
          const flip = z.object({ service: MockService, env: MockEnvironment, state: MockState }).safeParse(req.params);
          if (!flip.success) return new Response(`Expected /_mock/<${MOCK_SERVICES.join("|")}>/<${MOCK_ENVIRONMENTS.join("|")}>/<up|down|slow>\n`, { status: 400 });
          states.set(`${flip.data.service}/${flip.data.env}`, flip.data.state);
          return Response.json(table());
        },
      },
      "/:env/ui/health": (req) => answer("ui", req),
      "/:env/meta/actuator/health": (req) => answer("meta", req),
      "/:env/auth/actuator/health": (req) => answer("auth", req),
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
  return { url: server.url.origin, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_SERVICES_PORT ?? 7471);
  const [command, ...flip] = process.argv.slice(2);
  if (command === "set") {
    const res = await fetch(`http://127.0.0.1:${port}/_mock/${flip.join("/")}`, { method: "POST" }).catch(() => null);
    console.log(res ? await res.text() : `No mock answers on port ${port}. Start it first: bun run mock:services`);
    process.exit(res?.ok ? 0 : 1);
  }
  const token = process.env.MOCK_SERVICES_TOKEN ?? "mock-token";
  const { url } = startMockServices({ port, token });
  console.log(`Mock services on ${url} (Ctrl+C stops them). <env> is prod, preprod or int.
  UI    ${url}/<env>/ui/health              plain 200
  Meta  ${url}/<env>/meta/actuator/health   {"status":"UP"}
  Auth  ${url}/<env>/auth/actuator/health   needs Bearer token: ${token}
Flip one:  bun run mock:services set <ui|meta|auth> <env> <up|down|slow>
States:    curl ${url}/_mock`);
}
