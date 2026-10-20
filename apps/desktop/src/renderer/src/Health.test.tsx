import { HEALTH_KEEP_MS, type ConnectionHealth, type HealthReport } from "@chiefbot/contracts";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { askText, HealthView, timeline } from "./Health.tsx";

const now = Date.UTC(2026, 9, 20, 12);
const minute = 60_000;
const check = (minutesAgo: number, status: ConnectionHealth["history"][number]["status"]) => ({ at: now - minutesAgo * minute, status, summary: status });

test("the status bar has a segment per check, joined with same-status neighbours; a gap without checks stays empty", () => {
  const history = [check(25 * 60, "ok"), check(24 * 60 - 2, "down"), check(60, "ok"), check(55, "ok"), check(50, "degraded"), check(45, "degraded"), check(40, "ok")];

  expect(timeline(history, now)).toEqual([
    // A check older than 24 hours is off the bar; one just inside starts at its edge.
    { status: "down", from: now - HEALTH_KEEP_MS, to: now - (24 * 60 - 2) * minute, checks: 1, summary: "down" },
    // Control was off between: the next check covers only its own 5 minutes.
    { status: "ok", from: now - 65 * minute, to: now - 55 * minute, checks: 2, summary: "ok" },
    { status: "degraded", from: now - 55 * minute, to: now - 45 * minute, checks: 2, summary: "degraded" },
    { status: "ok", from: now - 45 * minute, to: now - 40 * minute, checks: 1, summary: "ok" },
  ]);
});

const report: HealthReport = {
  checkable: ["Dynatrace", "Google Cloud", "Looker"],
  connections: [
    {
      name: "gcloud",
      title: "Google Cloud",
      latest: {
        at: now - 2 * minute,
        status: "degraded",
        summary: "1 of 1 Cloud Run service ready · 1 Google Cloud incident in europe-west2",
        items: [{ status: "degraded", title: "Multiple services are experiencing issues.", detail: "Multiple Products · europe-west2", url: "https://status.cloud.google.com/incidents/abc" }],
      },
      history: [check(7, "ok"), check(2, "degraded")],
    },
    { name: "looker", title: "Looker", latest: null, history: [] },
  ],
};

test("the screen leads with the worst status, and each problem row has Ask my bot, off without a bot", () => {
  const html = renderToStaticMarkup(<HealthView report={report} now={now} onConnectApps={() => {}} onAsk={() => {}} />);
  const noBot = renderToStaticMarkup(<HealthView report={report} now={now} onConnectApps={() => {}} onAsk={null} />);

  expect(html).toContain("Something is degraded");
  expect(html).toContain("1 degraded · 1 not checked yet · checked 2 min ago");
  expect(html).toContain("Not checked yet");
  expect(html).toContain('href="https://status.cloud.google.com/incidents/abc"');
  expect(html.match(/Ask my bot/g)?.length).toBe(1);
  expect(noBot).toContain('title="Create a bot first"');
  expect(askText("Google Cloud", { status: "degraded", title: "Cloud Run service api is not ready", detail: "Revision api-00002 failed." })).toBe(
    "My Google Cloud health check says: Cloud Run service api is not ready\nRevision api-00002 failed.\n\nFind out why, and tell me what to do about it.",
  );
});

test("a connection not checked yet keeps the headline at Checking, never Everything is healthy", () => {
  const [gcloud, looker] = report.connections;
  if (!gcloud?.latest || !looker) throw new Error("the report fixture changed");
  const healthy = { ...gcloud, latest: { ...gcloud.latest, status: "ok" as const, items: [] }, history: [check(2, "ok")] };

  const html = renderToStaticMarkup(<HealthView report={{ ...report, connections: [healthy, looker] }} now={now} onConnectApps={() => {}} onAsk={null} />);

  expect(html).toContain("Checking your connections");
  expect(html).not.toContain("Everything is healthy");
});

test("screen readers hear each problem's severity and what the status bar shows", () => {
  const html = renderToStaticMarkup(<HealthView report={report} now={now} onConnectApps={() => {}} onAsk={null} />);

  expect(html).toContain('<span class="sr-only">Degraded: </span>Multiple services are experiencing issues.');
  expect(html).toMatch(/aria-label="Last 24 hours, 50% healthy: healthy [^"]+ to [^"]+, degraded [^"]+ to [^"]+"/);
});

test("with no connection to check, the screen names what it can check and opens Connect apps", () => {
  const html = renderToStaticMarkup(<HealthView report={{ ...report, connections: [] }} now={now} onConnectApps={() => {}} onAsk={null} />);

  expect(html).toContain("Nothing to check yet");
  expect(html).toContain("Health checks Dynatrace, Google Cloud and Looker for you every 5 minutes");
  expect(html).toContain("Open Connect apps");
});
