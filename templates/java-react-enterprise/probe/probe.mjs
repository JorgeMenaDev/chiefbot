// Drives one copy of the stack with a real browser, from inside that copy's network
// namespace, so localhost is the copy. check.sh runs it:
//   probe.mjs create <name>            log in, see the seeded records, create <name>
//   probe.mjs isolated <own> <other>   see <own> and not <other>
import { chromium } from "playwright";

const [mode, own, other] = process.argv.slice(2);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ httpCredentials: { username: "alice", password: "alice-password" } });
  const page = await context.newPage();
  const cell = (name) => page.getByRole("cell", { name, exact: true });

  // Log in at the gateway, as a person would: it answers 401 Basic, the browser
  // sends the password, and the gateway sets its auth cookie for Domain=localhost.
  await page.goto("http://localhost:8081/acme-ui/");
  await page.getByText("Signed in as Alice Example").waitFor();
  const auth = (await context.cookies("http://localhost:8081")).find((cookie) => cookie.name === "auth");
  if (auth?.domain.replace(/^\./, "") !== "localhost") throw new Error(`no auth cookie for localhost: ${JSON.stringify(auth)}`);

  // Then the UI on its own port, as a developer opens it. The page now calls the
  // gateway across origins, which only the hard-coded CORS origin allows.
  await page.goto("http://localhost:3000/acme-ui");
  await page.getByText("Signed in as Alice Example").waitFor();
  await cell("live-alpha").waitFor();
  const seeded = await page.getByRole("row").count() - 1;

  if (mode === "create") {
    await page.getByLabel("Name").fill(own);
    await page.getByLabel("Note").fill("Made by the probe");
    await page.getByRole("button", { name: "Create" }).click();
    await cell(own).waitFor();
    console.log(`logged in, saw ${seeded} seeded records, created ${own}`);
  } else if (mode === "isolated") {
    await cell(own).waitFor();
    if ((await cell(other).count()) > 0) throw new Error(`this copy sees the other copy's record ${other}`);
    console.log(`sees ${own}, not ${other}`);
  } else {
    throw new Error("usage: probe.mjs create <name> | isolated <own> <other>");
  }
} finally {
  await browser.close();
}
