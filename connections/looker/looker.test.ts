import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConnections, repoConnections } from "../../apps/control/src/connections/catalog.ts";
import { approvalFor } from "../../apps/worker/src/approvals.ts";
import { stageConnections } from "../../apps/worker/src/connections.ts";
import { fakeRequest } from "../../apps/worker/src/fakeCopilot.ts";

// The Looker connection as the repo ships it, with the fields a person saved.
const definition = loadConnections(repoConnections).find(({ name }) => name === "looker");
if (!definition) throw new Error("connections/looker did not load");
const secret = "fake-client-secret";
const token = "fake-access-token";

// A fake Looker API: login takes the client ID and secret as a form and gives a
// token; every other call needs that token. It notes each request it gets.
const requests: { method: string; path: string; auth: string | null; body: string }[] = [];
const looker = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname, search } = new URL(request.url);
    const body = await request.text();
    requests.push({ method: request.method, path: pathname + search, auth: request.headers.get("authorization"), body });
    if (pathname === "/api/4.0/login") {
      const form = new URLSearchParams(body);
      if (form.get("client_id") === "redirect-me") return Response.redirect(`http://127.0.0.1:${elsewhere.port}/api/4.0/login`, 307);
      return form.get("client_id") === "octo-client" && form.get("client_secret") === secret
        ? Response.json({ access_token: token, token_type: "Bearer", expires_in: 3600 })
        : Response.json({ message: `No API key matches ${body}` }, { status: 404 });
    }
    if (request.headers.get("authorization") !== `token ${token}`) return Response.json({ message: "Requires authentication" }, { status: 401 });
    if (pathname === "/api/4.0/user") return Response.json({ id: "1", display_name: "Octo User" });
    if (pathname === "/api/4.0/users/echo") return Response.json({ message: `Something broke for ${request.headers.get("authorization")}` }, { status: 500 });
    if (pathname === "/api/4.0/queries/run/json") return Response.json([{ "history.status": "error" }]);
    if (pathname === "/api/4.0/connections/my%20db/test") return Response.json([{ name: "connect", status: "success" }]);
    return Response.json({ message: "Not found" }, { status: 404 });
  },
});
// Another host, which must never see a request.
const elsewhere = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    requests.push({ method: request.method, path: `elsewhere ${new URL(request.url).pathname}`, auth: null, body: "" });
    return new Response("{}");
  },
});
afterAll(() => {
  looker.stop(true);
  elsewhere.stop(true);
});

const dirs: string[] = [];
afterEach(() => {
  requests.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Runs `command` in a shell as a bot's turn would: the connection staged with
// `fields`, its wrapper first on PATH, and looker.ts installed as `looker` behind it.
async function run(command: string, { url = `http://127.0.0.1:${looker.port}/`, clientid = "octo-client" } = {}) {
  if (!definition) throw new Error("unreachable");
  const root = join(mkdtempSync(join(tmpdir(), "chiefbot-looker-")), "chiefbot");
  const tools = mkdtempSync(join(tmpdir(), "chiefbot-looker-tools-"));
  dirs.push(dirname(root), tools);
  symlinkSync(join(import.meta.dir, "looker.ts"), join(tools, "looker"));
  stageConnections(root, [{ ...definition, fields: { url, clientid, secret } }]);
  const child = Bun.spawn(["sh", "-c", command], { env: { PATH: `${root}/bin:${tools}:${dirname(process.execPath)}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stdout + stderr).not.toContain(token);
  expect(stdout + stderr).not.toContain(secret);
  return { stdout, stderr, code };
}

test("looker signs in with the person's client ID and secret, then reads with the token it got, never printing either", async () => {
  const { stdout, code } = await run("looker get /user");

  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ id: "1", display_name: "Octo User" });
  expect(requests).toEqual([
    { method: "POST", path: "/api/4.0/login", auth: null, body: `client_id=octo-client&client_secret=${secret}` },
    { method: "GET", path: "/api/4.0/user", auth: `token ${token}`, body: "" },
  ]);
});

test("the health reads: a System Activity query is a POST to /queries/run/json, a connection test a PUT to its test path", async () => {
  const query = '{"model":"system__activity","view":"history","fields":["history.message"],"filters":{"history.status":"error"}}';

  expect((await run(`looker activity '${query}'`)).code).toBe(0);
  expect((await run("looker test-connection 'my db'")).code).toBe(0);
  expect(requests.filter(({ path }) => path !== "/api/4.0/login").map(({ method, path, body }) => [method, path, body])).toEqual([
    ["POST", "/api/4.0/queries/run/json", query],
    ["PUT", "/api/4.0/connections/my%20db/test", ""],
  ]);
});

test("a wrong secret or a request Looker refuses fails with Looker's message, the secret and token cut out", async () => {
  const signIn = await run("looker get /user", { clientid: "wrong-client" });
  expect([signIn.code, signIn.stderr]).toEqual([1, expect.stringContaining("signing in failed (404)")]);
  expect(signIn.stderr).toContain("client_secret=[redacted]");

  const broken = await run("looker get /users/echo");
  expect([broken.code, broken.stderr]).toEqual([1, expect.stringContaining("GET /users/echo failed (500)")]);
  expect(broken.stderr).toContain("token [redacted]");
  expect(requests.map(({ path }) => path)).toEqual(["/api/4.0/login", "/api/4.0/login", "/api/4.0/users/echo"]);
});

test("the credentials go only to the instance, over HTTPS (or this computer): no redirect is followed", async () => {
  const redirected = await run("looker get /user", { clientid: "redirect-me" });
  const plain = await run("looker get /user", { url: "http://looker.example.com" });

  expect([redirected.code, redirected.stderr]).toEqual([1, expect.stringContaining("redirect (307)")]);
  expect([plain.code, plain.stderr]).toEqual([1, expect.stringContaining("must start with https://")]);
  expect(requests.map(({ path }) => path)).toEqual(["/api/4.0/login"]);
});

test("what runs without asking can do no more than read: get only its paths, activity only System Activity", async () => {
  for (const command of [
    "looker get '/queries/1/run/json?rebuild_pdts=true'",
    "looker get /looks/1/run/json",
    "looker get /connections/../queries/1/run/json",
    "looker get /connections/x%2F..%2F..%2Fqueries%2F1%2Frun%2Fjson",
    "looker get /derived_table/shop/orders/start",
    `looker activity '{"model":"shop","view":"orders","fields":["orders.count"]}'`,
    "looker get /user extra",
  ]) {
    expect((await run(command)).code).toBe(2);
  }
  expect(requests).toEqual([]);
  // The same through request reaches Looker (after the approval the connection asks for).
  expect((await run("looker request put '/connections/my%20db/test'")).code).toBe(0);
  expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual(["POST /api/4.0/login", "PUT /api/4.0/connections/my%20db/test"]);
});

test("reads and health checks run without asking; anything that may change Looker asks", () => {
  if (!definition) throw new Error("unreachable");
  const ask = (command: string) => approvalFor(fakeRequest.shell(command), [{ ...definition, fields: {} }]);

  for (const read of [
    "looker --help",
    "looker get /user",
    "looker get '/connections?fields=name,dialect_name'",
    `looker activity '{"model":"system__activity","view":"history","filters":{"history.status":"error"}}'`,
    "looker test-connection warehouse",
  ]) {
    expect(ask(read)).toBeNull();
  }
  for (const write of [
    "looker request GET /queries/1/run/json",
    "looker request POST /scheduled_plans/7/run_once",
    `looker request PATCH /users/1 '{"is_disabled":true}'`,
    "looker request DELETE /looks/1",
    "looker get /user && looker request DELETE /looks/1",
    "looker query '{}'",
  ]) {
    expect(ask(write)?.kind).toBe("connector");
  }
});
