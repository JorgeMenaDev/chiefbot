// Drives one copy of the stack with a real browser, from inside that copy's network
// namespace, so localhost is the copy. check.sh runs it:
//   probe.mjs create <name>            log in, see the seeded records, create <name>
//   probe.mjs isolated <own> <other>   see <own> and not <other>
import { chromium } from "playwright";

const gateway = "http://localhost:8081";
// The rows in seed/data/<schema>.csv.
const seeded = {
  live: ["live-alpha", "live-bravo", "live-charlie"],
  sandbox: ["sandbox-alpha", "sandbox-bravo"],
  experimental: ["experimental-alpha"],
};

function check(ok, message) {
  if (!ok) throw new Error(message);
}

const [mode, own, other] = process.argv.slice(2);
check(mode === "create" || mode === "isolated", "usage: probe.mjs create <name> | isolated <own> <other>");
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ httpCredentials: { username: "alice", password: "alice-password" } });
  const page = await context.newPage();
  const cell = (name) => page.getByRole("cell", { name, exact: true });

  // Log in at the gateway, as a person would: it answers 401 Basic, the browser
  // sends the password, and the gateway sets its auth cookie for Domain=localhost.
  await page.goto(`${gateway}/acme-ui/`);
  await page.getByText("Signed in as Alice Example").waitFor();
  const auth = (await context.cookies(gateway)).find((cookie) => cookie.name === "auth");
  check(auth?.domain.replace(/^\./, "") === "localhost", `no auth cookie for localhost: ${JSON.stringify(auth)}`);

  // The auth cookie alone gets in: a browser with no password and nothing but that
  // cookie reads every schema's seeded records. Without the cookie it gets 401.
  const cookieOnly = await browser.newContext();
  await cookieOnly.addCookies([auth]);
  const tab = await cookieOnly.newPage();
  for (const [schema, names] of Object.entries(seeded)) {
    const response = await tab.goto(`${gateway}/acme-meta/v1/records?schema=${schema}`);
    const headers = await response.request().allHeaders();
    check(!("authorization" in headers) && /(^|; )auth=/.test(headers.cookie ?? ""), `sent more than the cookie: ${Object.keys(headers)}`);
    check(response.status() === 200, `the auth cookie alone got ${response.status()} for ${schema}`);
    const found = (await response.json()).map((record) => record.name);
    const missing = names.filter((name) => !found.includes(name));
    check(missing.length === 0, `${schema} lacks seeded records ${missing}`);
  }
  await cookieOnly.clearCookies();
  const without = await tab.goto(`${gateway}/acme-meta/v1/me`);
  check(without.status() === 401, `without the auth cookie the gateway answered ${without.status()}`);
  await cookieOnly.close();

  // Then the UI on its own port, as a developer opens it. The page calls the
  // gateway across origins, which only the hard-coded CORS origin allows.
  await page.goto("http://localhost:3000/acme-ui");
  await page.getByText("Signed in as Alice Example").waitFor();
  for (const name of seeded.live) await cell(name).waitFor();

  if (mode === "create") {
    await page.getByLabel("Name").fill(own);
    await page.getByLabel("Note").fill("Made by the probe");
    await page.getByRole("button", { name: "Create" }).click();
    await cell(own).waitFor();
    console.log(`logged in; the auth cookie alone works and its absence gets 401; saw all 6 seeded records; created ${own}`);
  } else {
    await cell(own).waitFor();
    check((await cell(other).count()) === 0, `this copy sees the other copy's record ${other}`);
    console.log(`sees ${own}, not ${other}`);
  }
} finally {
  await browser.close();
}
