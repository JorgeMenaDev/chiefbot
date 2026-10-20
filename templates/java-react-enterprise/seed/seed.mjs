// The one-shot seed. It runs its jobs in order through the gateway, logged in with
// Basic credentials: first the identity call, which makes the user's row in meta,
// then one CSV upload per schema, since records need that row. Uploads skip names
// that exist, so running the seed twice changes nothing.
import { readFile } from "node:fs/promises";

const api = "http://localhost:8081/acme-meta/v1";
const authorization = `Basic ${Buffer.from(process.env.ACME_SEED_BASIC_AUTH ?? "").toString("base64")}`;

async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, { ...init, headers: { authorization } });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return response.json();
}

async function upload(schema) {
  const csv = await readFile(new URL(`data/${schema}.csv`, import.meta.url));
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), `${schema}.csv`);
  return call(`/uploads?schema=${schema}`, { method: "POST", body: form });
}

const jobs = [
  ["user row", () => call("/me")],
  ["live records", () => upload("live")],
  ["sandbox records", () => upload("sandbox")],
  ["experimental records", () => upload("experimental")],
];
for (const [index, [name, run]] of jobs.entries()) {
  console.log(`seed ${index + 1}/${jobs.length} ${name}: ${JSON.stringify(await run())}`);
}
