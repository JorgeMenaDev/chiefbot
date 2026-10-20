import { afterEach, expect, test } from "bun:test";
import { gcloudProbe } from "./gcloud.ts";

const stops: Array<() => void> = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

const key = JSON.stringify({ type: "authorized_user", client_id: "client.apps.example", client_secret: "client-secret", refresh_token: "1//refresh" });
const fields = { key, project: "demo-project" };
const ready = { state: "CONDITION_SUCCEEDED" };
const service = (region: string, name: string, terminalCondition: object) => ({ name: `projects/demo-project/locations/${region}/services/${name}`, terminalCondition });
const incident = (id: string, desc: string, locations: string[], extra: object = {}) => ({
  id,
  uri: `incidents/${id}`,
  begin: "2026-10-20T06:08:00+00:00",
  external_desc: desc,
  service_name: "Multiple Products",
  affected_products: [{ title: "Cloud Run" }],
  currently_affected_locations: locations.map((location) => ({ id: location, title: location })),
  ...extra,
});
const gkeOff = {
  error: {
    code: 403,
    message:
      "Kubernetes Engine API has not been used in project demo-project before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/container.googleapis.com/overview?project=demo-project then retry.",
    status: "PERMISSION_DENIED",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", metadata: { activationUrl: "https://console.developers.google.com/apis/api/container.googleapis.com/overview?project=demo-project" } }],
  },
};

// A fake Google: its token endpoint takes the key's refresh grant, and Cloud Run
// (two pages), GKE and the status page answer what the test gives them, to that token only.
function fakeGoogle(answers: { services: object[][]; clusters: { status: number; body: object }; incidents: object[] }) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname, searchParams } = new URL(req.url);
      if (pathname === "/token") {
        const form = new URLSearchParams(await req.text());
        return form.get("refresh_token") === "1//refresh" ? Response.json({ access_token: "ya29.fake" }) : Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (pathname === "/incidents.json") return Response.json(answers.incidents);
      if (req.headers.get("authorization") !== "Bearer ya29.fake") return Response.json({ error: { message: "Request had invalid authentication credentials." } }, { status: 401 });
      if (pathname === "/v2/projects/demo-project/locations/-/services") {
        const page = Number(searchParams.get("pageToken") ?? 0);
        return Response.json({ services: answers.services[page], ...(page + 1 < answers.services.length ? { nextPageToken: String(page + 1) } : {}) });
      }
      if (pathname === "/v1/projects/demo-project/locations/-/clusters") return Response.json(answers.clusters.body, { status: answers.clusters.status });
      return new Response("not found", { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  const url = server.url.origin;
  return gcloudProbe({ token: `${url}/token`, run: url, container: url, incidents: `${url}/incidents.json` });
}

const signal = () => AbortSignal.timeout(5000);

test("a failed Cloud Run service is down, GKE that is turned off is unknown with Google's reason, and open incidents in the project's regions count", async () => {
  const probe = fakeGoogle({
    services: [[service("europe-west2", "hello", ready)], [service("us-central1", "api", { state: "CONDITION_FAILED", message: "Revision 'api-00002' is not ready." })]],
    clusters: { status: 403, body: gkeOff },
    incidents: [
      incident("here", "Multiple services are experiencing issues in the europe-west2 region.", ["europe-west2"]),
      incident("ended", "An earlier one.", ["europe-west2"], { end: "2026-10-19T10:00:00+00:00" }),
      incident("elsewhere", "Asia is slow.", ["asia-south2"]),
      incident("global", "Cloud Run deploys fail everywhere.", ["global"]),
    ],
  });

  expect(await probe(fields, signal())).toEqual({
    status: "down",
    summary: "1 of 2 Cloud Run services ready · GKE not checked · 2 Google Cloud incidents in europe-west2, us-central1",
    items: [
      { status: "down", title: "Cloud Run service api in us-central1 is not ready", detail: "Revision 'api-00002' is not ready." },
      {
        status: "unknown",
        title: "Couldn't check GKE clusters",
        detail: "Kubernetes Engine API has not been used in project demo-project before or it is disabled. (403)",
        url: "https://console.developers.google.com/apis/api/container.googleapis.com/overview?project=demo-project",
      },
      {
        status: "degraded",
        title: "Multiple services are experiencing issues in the europe-west2 region.",
        detail: "Multiple Products · europe-west2",
        url: "https://status.cloud.google.com/incidents/here",
      },
      { status: "degraded", title: "Cloud Run deploys fail everywhere.", detail: "Multiple Products · global", url: "https://status.cloud.google.com/incidents/global" },
    ],
  });
});

test("ready services, running clusters and no incidents are ok; a degraded cluster is degraded", async () => {
  const healthy = fakeGoogle({
    services: [[service("europe-west2", "hello", ready)]],
    clusters: { status: 200, body: { clusters: [{ name: "prod", location: "europe-west2-a", status: "RUNNING" }] } },
    incidents: [incident("elsewhere", "Asia is slow.", ["asia-south2"])],
  });
  const degraded = fakeGoogle({
    services: [[]],
    clusters: { status: 200, body: { clusters: [{ name: "prod", location: "europe-west2", status: "DEGRADED", statusMessage: "Node pool default is unhealthy." }] } },
    incidents: [],
  });

  expect(await healthy(fields, signal())).toEqual({
    status: "ok",
    summary: "1 of 1 Cloud Run service ready · 1 of 1 GKE cluster running · No Google Cloud incidents in europe-west2",
    items: [],
  });
  expect(await degraded(fields, signal())).toMatchObject({
    status: "degraded",
    summary: "No Cloud Run services · 0 of 1 GKE cluster running · No Google Cloud incidents in europe-west2",
    items: [{ status: "degraded", title: "GKE cluster prod in europe-west2 is degraded", detail: "Node pool default is unhealthy." }],
  });
});

test("a key Google refuses is unknown, never ok, and the result never holds the key", async () => {
  const probe = fakeGoogle({ services: [[]], clusters: { status: 200, body: {} }, incidents: [] });
  const refused = { ...fields, key: JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: "client-secret", refresh_token: "1//revoked" }) };

  const result = await probe(refused, signal());

  expect(result).toEqual({
    status: "unknown",
    summary: "Not checked",
    items: [{ status: "unknown", title: "Couldn't sign in to Google Cloud", detail: "Google refused the saved key: 400 invalid_grant" }],
  });
  expect(JSON.stringify(result)).not.toContain("client-secret");
});
