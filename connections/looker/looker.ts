#!/usr/bin/env bun
// looker: a small Looker API 4.0 client, the CLI of the Looker connection
// (connection.yaml; install.sh puts it on the computer as /usr/local/bin/looker).
// Each run signs in with the API client ID and secret in LOOKERSDK_CLIENT_ID and
// LOOKERSDK_CLIENT_SECRET (POST /api/4.0/login), makes one request to
// LOOKERSDK_BASE_URL with the token it got, and prints the response body. The
// token lives only in this process: it is never printed or written anywhere.
//
// get, activity and test-connection only read, and the connection runs them
// without asking, so each checks here that it cannot do more: get takes only the
// paths in `reads` (never a query run, which can build tables in the database),
// activity only System Activity queries (Looker's own database, no derived tables).
// Anything else goes through `request`, which the connection always asks about.

// A module, for its top-level awaits.
export {};

const usage = `Usage:
  looker get <path>                      read the instance, a user, connections, schedules, dashboards, Looks, models or folders
  looker activity '<query json>'         run a System Activity query ("model": "system__activity")
  looker test-connection <name>          test a database connection (PUT /connections/<name>/test)
  looker request <method> <path> ['<json>']   anything else: other reads, running queries, changes
<path> is an API 4.0 path that starts with /, like /scheduled_plans or '/connections?fields=name'.`;

// The API paths `looker get` reads (query string aside): none runs a query.
const reads = [
  /^\/versions$/,
  /^\/user$/,
  /^\/users(\/[^/]+)?$/,
  /^\/connections(\/[^/]+)?$/,
  /^\/running_queries$/,
  /^\/scheduled_plans(\/[^/]+)?$/,
  /^\/dashboards(\/[^/]+)?$/,
  /^\/looks(\/[^/]+)?$/,
  /^\/lookml_models(\/[^/]+)?$/,
  /^\/folders(\/[^/]+)?$/,
];

type Call = { method: string; path: string; body?: string };

// The one request `args` asks for, or why they are not one of the usages.
function parse([command, ...rest]: string[]): Call | string {
  const [first, second, third] = rest;
  if (first === undefined || first === "") return "not a usage it knows.";
  switch (command) {
    case "get":
      return rest.length === 1 ? { method: "GET", path: first } : "get takes one path.";
    case "activity":
      return rest.length === 1 ? { method: "POST", path: "/queries/run/json", body: first } : "activity takes one query.";
    case "test-connection":
      return rest.length === 1 ? { method: "PUT", path: `/connections/${encodeURIComponent(first)}/test` } : "test-connection takes one name.";
    case "request":
      if (second === undefined || rest.length > 3) return "request takes a method, a path and maybe a body.";
      return third === undefined ? { method: first.toUpperCase(), path: second } : { method: first.toUpperCase(), path: second, body: third };
    default:
      return "not a usage it knows.";
  }
}

// Ends the run with `message` on stderr.
function fail(message: string, code = 1): never {
  console.error(`looker: ${message}`);
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log(usage);
  process.exit(args.length === 0 ? 2 : 0);
}
const call = parse(args);
if (typeof call === "string") fail(`${call}\n${usage}`, 2);
if (!call.path.startsWith("/")) fail("a path starts with /.", 2);
const body: unknown = (() => {
  if (call.body === undefined) return undefined;
  try {
    return JSON.parse(call.body);
  } catch {
    fail("the body is not JSON.", 2);
  }
})();
if (args[0] === "activity" && !(typeof body === "object" && body !== null && "model" in body && body.model === "system__activity")) {
  fail('activity runs only System Activity queries ("model": "system__activity"). Run others with looker request POST /queries/run/json.', 2);
}

const { LOOKERSDK_BASE_URL: url, LOOKERSDK_CLIENT_ID: clientId, LOOKERSDK_CLIENT_SECRET: clientSecret } = process.env;
if (!url || !clientId || !clientSecret) fail("LOOKERSDK_BASE_URL, LOOKERSDK_CLIENT_ID and LOOKERSDK_CLIENT_SECRET must be set: turn the Looker connection on in Connect apps.");
const base = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
// The credentials travel only over HTTPS, or to this computer itself (the tests' fake Looker).
if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) {
  fail(`the instance URL must start with https:// (it is ${base.origin}).`);
}
const api = `${base.origin}${base.pathname.replace(/\/+$/, "")}/api/4.0`;
// The path is appended as text, so it can never point the token at another host.
// get checks the path as it will be sent, after the URL's own clean-up of `..`,
// and refuses an encoded `/` or `.` that a server could decode into another path.
const target = new URL(`${api}${call.path}`);
const sent = target.pathname.slice(new URL(api).pathname.length);
if (args[0] === "get" && (/%2[ef]/i.test(sent) || !reads.some((read) => read.test(sent)))) {
  fail("get reads only /versions, /user, /running_queries, and /users, /connections, /scheduled_plans, /dashboards, /looks, /lookml_models or /folders, each with or without an id. Use looker request GET for any other path.", 2);
}

// What the user sees of a response: its body, JSON pretty-printed, with the
// secret and the token cut out in case Looker (or a proxy) echoes them.
let token: string | null = null;
async function shown(response: Response) {
  let text = await response.text();
  try {
    text = JSON.stringify(JSON.parse(text), null, 2);
  } catch {}
  for (const hidden of [clientSecret, token]) if (hidden) text = text.replaceAll(hidden, "[redacted]");
  return text;
}

// Redirects are refused, not followed: they could carry the secret or the token to another host.
async function send(path: string, init: RequestInit, what: string) {
  const response = await fetch(`${api}${path}`, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) fail(`${what}: Looker answered with a redirect (${response.status}), which looker does not follow. Check the instance URL.`);
  if (!response.ok) fail(`${what} failed (${response.status}): ${await shown(response)}`);
  return response;
}

const session: unknown = await (await send("/login", { method: "POST", body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }) }, "signing in")).json();
token = typeof session === "object" && session !== null && "access_token" in session && typeof session.access_token === "string" ? session.access_token : null;
if (token === null) fail("signing in returned no access token.");

const response = await send(
  call.path,
  {
    method: call.method,
    headers: { Authorization: `token ${token}`, ...(call.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(call.body === undefined ? {} : { body: call.body }),
  },
  `${call.method} ${call.path}`,
);
console.log(await shown(response));
