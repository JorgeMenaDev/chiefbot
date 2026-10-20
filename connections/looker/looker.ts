#!/usr/bin/env bun
// looker: a small Looker API 4.0 client, the CLI of the Looker connection
// (connection.yaml; install.sh puts it on the computer as /usr/local/bin/looker).
// Each run signs in with the API client ID and secret in LOOKERSDK_CLIENT_ID and
// LOOKERSDK_CLIENT_SECRET (POST /api/4.0/login), makes one request to
// LOOKERSDK_BASE_URL with the token it got, and prints the response body. The
// token lives only in this process: it is never printed or written anywhere.

// A module, for its top-level awaits.
export {};

const usage = `Usage:
  looker get <path>                     read anything, like /user or '/connections?fields=name'
  looker query '<query json>'           run an inline query (POST /queries/run/json); it only reads
  looker test-connection <name>         test a database connection (PUT /connections/<name>/test)
  looker post|put|patch <path> ['<json>']
  looker delete <path>
<path> is an API 4.0 path that starts with /, like /scheduled_plans.`;

type Call = { method: string; path: string; body?: string };

// The one request `args` asks for, or null when they are not one of the usages.
function parse([command, ...rest]: string[]): Call | null {
  const [first, second] = rest;
  if (first === undefined || first === "") return null;
  const isPath = first.startsWith("/");
  switch (command) {
    case "get":
    case "delete":
      return rest.length === 1 && isPath ? { method: command.toUpperCase(), path: first } : null;
    case "post":
    case "put":
    case "patch":
      if (rest.length > 2 || !isPath) return null;
      return second === undefined ? { method: command.toUpperCase(), path: first } : { method: command.toUpperCase(), path: first, body: second };
    case "query":
      return rest.length === 1 ? { method: "POST", path: "/queries/run/json", body: first } : null;
    case "test-connection":
      return rest.length === 1 ? { method: "PUT", path: `/connections/${encodeURIComponent(first)}/test` } : null;
    default:
      return null;
  }
}

// Ends the run with `message` on stderr.
function fail(message: string, code = 1): never {
  console.error(`looker: ${message}`);
  process.exit(code);
}

// A response body as text, JSON pretty-printed.
async function shown(response: Response) {
  const text = await response.text();
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log(usage);
  process.exit(args.length === 0 ? 2 : 0);
}
const call = parse(args);
if (call === null) fail(`not a usage it knows.\n${usage}`, 2);
if (call.body !== undefined) {
  try {
    JSON.parse(call.body);
  } catch {
    fail("the body is not JSON.", 2);
  }
}

const { LOOKERSDK_BASE_URL: url, LOOKERSDK_CLIENT_ID: clientId, LOOKERSDK_CLIENT_SECRET: clientSecret } = process.env;
if (!url || !clientId || !clientSecret) fail("LOOKERSDK_BASE_URL, LOOKERSDK_CLIENT_ID and LOOKERSDK_CLIENT_SECRET must be set: turn the Looker connection on in Connect apps.");
// The path is appended as text, so it can never point the token at another host.
const base = /^https?:\/\//.test(url) ? url : `https://${url}`;
const api = `${base.replace(/\/+$/, "")}/api/4.0`;

const login = await fetch(`${api}/login`, { method: "POST", body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }) });
if (!login.ok) fail(`signing in failed (${login.status}): ${await shown(login)}`);
const session: unknown = await login.json();
const token = typeof session === "object" && session !== null && "access_token" in session && typeof session.access_token === "string" ? session.access_token : null;
if (token === null) fail("signing in returned no access token.");

const response = await fetch(`${api}${call.path}`, {
  method: call.method,
  headers: { Authorization: `token ${token}`, ...(call.body === undefined ? {} : { "Content-Type": "application/json" }) },
  ...(call.body === undefined ? {} : { body: call.body }),
});
const body = await shown(response);
if (!response.ok) fail(`${call.method} ${call.path} failed (${response.status}): ${body}`);
console.log(body);
