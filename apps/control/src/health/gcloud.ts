import { worstStatus, type HealthItem } from "@chiefbot/contracts";
import { z } from "zod";
import { googleAccessToken, googleTokenUrl } from "../connections/googleToken.ts";
import { call, combine, failure, notChecked, plural, type Part, type Probe } from "./probe.ts";

// Where the gcloud probe reads: Google's in production, fakes in tests.
export type GoogleUrls = { token: string; run: string; container: string; incidents: string };

export const googleUrls: GoogleUrls = {
  token: googleTokenUrl,
  run: "https://run.googleapis.com",
  container: "https://container.googleapis.com",
  incidents: "https://status.cloud.google.com/incidents.json",
};

// Google Cloud's probe, with a one-hour token minted from the saved key (as each
// turn gets one): the project's Cloud Run services and their Ready condition
// (Cloud Run Admin API v2), its GKE clusters and their status, and Google
// Cloud's open incidents (status.cloud.google.com) in the regions those run in,
// or global ones for Cloud Run or GKE.
export function gcloudProbe(urls: GoogleUrls): Probe {
  return async ({ key = "", project = "" }, signal) => {
    let token: string;
    try {
      token = await googleAccessToken(key, urls.token);
    } catch (error) {
      return combine([notChecked("Not checked", "Couldn't sign in to Google Cloud", failure(error))]);
    }
    const parent = `projects/${encodeURIComponent(project)}/locations/-`;
    const get = (url: string) => call(url, { headers: { authorization: `Bearer ${token}` }, signal });
    const [run, gke] = await Promise.all([cloudRun(get, `${urls.run}/v2/${parent}/services`), clusters(get, `${urls.container}/v1/${parent}/clusters`)]);
    const regions = new Set([...run.regions, ...gke.regions]);
    return combine([run, gke, await incidents(urls.incidents, regions, signal)]);
  };
}

type Get = (url: string) => Promise<{ status: number; body: unknown }>;

// Google's error body: its message names the API and project, and an
// API that is off says how to turn it on.
const GoogleError = z.object({
  error: z.object({
    message: z.string(),
    details: z.array(z.object({ metadata: z.object({ activationUrl: z.string().startsWith("https://") }).optional() })).optional(),
  }),
});

// `what` could not be checked: Google's reason (its first sentence), and the page that turns the API on.
function refused(what: string, phrase: string, { status, body }: { status: number; body: unknown }): Part {
  const error = GoogleError.safeParse(body);
  if (!error.success) return notChecked(phrase, `Couldn't check ${what}`, `Google answered ${status}.`);
  const [sentence = ""] = error.data.error.message.split(/(?<=\.)\s/);
  const url = error.data.error.details?.find(({ metadata }) => metadata)?.metadata?.activationUrl;
  return notChecked(phrase, `Couldn't check ${what}`, `${sentence} (${status})`, url);
}

const Condition = z.object({ state: z.string().optional(), message: z.string().optional(), reason: z.string().optional() });
const ServicePage = z.object({
  services: z.array(z.object({ name: z.string(), terminalCondition: Condition.optional() })).default([]),
  nextPageToken: z.string().optional(),
});

// Every Cloud Run service of the project, at most 10 pages: Ready (CONDITION_SUCCEEDED)
// is ok, failed is down, anything else (deploying, pending) is degraded.
async function cloudRun(get: Get, url: string): Promise<Part & { regions: string[] }> {
  const services: z.infer<typeof ServicePage>["services"] = [];
  let pageToken = "";
  try {
    for (let page = 0; page < 10; page++) {
      const res = await get(`${url}?pageSize=200${pageToken && `&pageToken=${encodeURIComponent(pageToken)}`}`);
      const body = ServicePage.safeParse(res.body);
      if (res.status !== 200 || !body.success) return { ...refused("Cloud Run services", "Cloud Run not checked", res), regions: [] };
      services.push(...body.data.services);
      pageToken = body.data.nextPageToken ?? "";
      if (!pageToken) break;
    }
  } catch (error) {
    return { ...notChecked("Cloud Run not checked", "Couldn't check Cloud Run services", failure(error)), regions: [] };
  }
  const items: HealthItem[] = [];
  const regions = new Set<string>();
  for (const { name, terminalCondition } of services) {
    // projects/<project>/locations/<region>/services/<name>
    const [, , , region = "", , short = name] = name.split("/");
    regions.add(region);
    const state = terminalCondition?.state ?? "STATE_UNSPECIFIED";
    if (state === "CONDITION_SUCCEEDED") continue;
    items.push({
      status: state === "CONDITION_FAILED" ? "down" : "degraded",
      title: `Cloud Run service ${short} in ${region} is not ready`,
      detail: terminalCondition?.message ?? terminalCondition?.reason ?? state,
    });
  }
  const ready = services.length - items.length;
  const phrase = services.length === 0 ? "No Cloud Run services" : `${ready} of ${plural(services.length, "Cloud Run service")} ready`;
  return { status: worstStatus(items.map(({ status }) => status)), phrase, items, regions: [...regions] };
}

const ClusterList = z.object({
  clusters: z.array(z.object({ name: z.string(), location: z.string().default(""), status: z.string().default("STATUS_UNSPECIFIED"), statusMessage: z.string().optional() })).default([]),
});

// GKE cluster status: RUNNING is ok, ERROR down, anything else (DEGRADED,
// RECONCILING while it upgrades, PROVISIONING, STOPPING) degraded.
async function clusters(get: Get, url: string): Promise<Part & { regions: string[] }> {
  let res: { status: number; body: unknown };
  try {
    res = await get(url);
  } catch (error) {
    return { ...notChecked("GKE not checked", "Couldn't check GKE clusters", failure(error)), regions: [] };
  }
  const list = ClusterList.safeParse(res.body);
  if (res.status !== 200 || !list.success) return { ...refused("GKE clusters", "GKE not checked", res), regions: [] };
  const all = list.data.clusters;
  const items: HealthItem[] = all
    .filter(({ status }) => status !== "RUNNING")
    .map(({ name, location, status, statusMessage }) => ({
      status: status === "ERROR" ? "down" : "degraded",
      title: `GKE cluster ${name} in ${location} is ${status.toLowerCase()}`,
      ...(statusMessage ? { detail: statusMessage } : {}),
    }));
  const phrase = all.length === 0 ? "No GKE clusters" : `${all.length - items.length} of ${plural(all.length, "GKE cluster")} running`;
  // A zonal cluster's location is a zone (europe-west2-a): its region drops the letter.
  const regions = all.map(({ location }) => location.replace(/-[a-z]$/, "")).filter(Boolean);
  return { status: worstStatus(items.map(({ status }) => status)), phrase, items, regions };
}

const Incident = z.object({
  external_desc: z.string(),
  uri: z.string().optional(),
  end: z.string().optional(),
  service_name: z.string().optional(),
  affected_products: z.array(z.object({ title: z.string() })).default([]),
  currently_affected_locations: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
});

// The products the probe watches, for incidents Google marks global.
const watched = ["Cloud Run", "Google Kubernetes Engine"];

// Google Cloud's open incidents (no end yet) in `regions`, or global ones for a watched product.
async function incidents(url: string, regions: Set<string>, signal: AbortSignal): Promise<Part> {
  let res: { status: number; body: unknown };
  try {
    res = await call(url, { signal });
  } catch (error) {
    return notChecked("Incidents not checked", "Couldn't read Google Cloud's incidents", failure(error));
  }
  if (res.status !== 200 || !Array.isArray(res.body)) return notChecked("Incidents not checked", "Couldn't read Google Cloud's incidents", `status.cloud.google.com answered ${res.status}.`);
  const open = res.body.flatMap((entry) => {
    const incident = Incident.safeParse(entry);
    if (!incident.success || incident.data.end) return [];
    const { currently_affected_locations: locations, affected_products: products } = incident.data;
    const here = locations.filter(({ id }) => regions.has(id) || (id === "global" && products.some(({ title }) => watched.includes(title))));
    return here.length > 0 ? [{ ...incident.data, here }] : [];
  });
  const items: HealthItem[] = open.map(({ external_desc, uri, service_name, here }) => ({
    status: "degraded",
    title: external_desc,
    detail: [service_name, here.map(({ title }) => title).join(", ")].filter(Boolean).join(" · "),
    ...(uri ? { url: `https://status.cloud.google.com/${uri.replace(/^\//, "")}` } : {}),
  }));
  const where = regions.size > 0 ? `in ${[...regions].sort().join(", ")}` : "for Cloud Run or GKE";
  const phrase = items.length > 0 ? `${plural(items.length, "Google Cloud incident")} ${where}` : `No Google Cloud incidents ${where}`;
  return { status: worstStatus(items.map(({ status }) => status)), phrase, items };
}
