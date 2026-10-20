import {
  HEALTH_INTERVAL_MS,
  HEALTH_KEEP_MS,
  HealthReport,
  ServiceHealth,
  worstStatus,
  type ConnectionHealth,
  type HealthItem,
  type HealthStatus,
  type Service,
} from "@chiefbot/contracts";
import { ActivityIcon, ExternalLinkIcon, MessageSquareIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorText, Muted, PaneBody, PaneHeader } from "./Pane.tsx";
import { ServiceDialog, ServicesCard, type ServiceActions } from "./Services.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Card } from "./components/ui/card.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty.tsx";
import { ago, badgeVariant, barColor, clock, StatusIcon, statusLabel } from "./healthStatus.tsx";
import { cn, listOf } from "./lib/utils.ts";

// The screen reloads control's kept checks this often while it is open.
const RELOAD_MS = 60_000;

// Health, from its icon beside the gear at the sidebar's bottom left, after T3 Code's
// usage page (apps/web/src/components/usage, MIT): one overall status, then a card per
// connection control checks, each with its latest status, a 24-hour status bar and the
// problems it found, then the person's own services (Services.tsx). Ask my bot opens a
// bot's chat with the problem written in. Control runs the checks (read-only, no AI):
// connections every 5 minutes and on Refresh; services when the screen opens, on
// Refresh and on a service's Check now.
export function Health({ onConnectApps, onAsk }: { onConnectApps: () => void; onAsk: ((text: string) => void) | null }) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  // The services being checked by their own Check now.
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  // The Add/Edit service dialog, with the service it edits (null: a new one).
  const [dialog, setDialog] = useState<{ service: Service | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = (next: unknown) => {
    setReport(HealthReport.parse(next));
    setNow(Date.now());
    setError(null);
  };
  const showServices = (next: unknown) => {
    const services = ServiceHealth.array().parse(next);
    setReport((current) => current && { ...current, services });
    setNow(Date.now());
  };
  const failed = (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught));
  const load = () => window.chiefbot.health.get().then(show, failed);

  // Opening the screen shows the kept checks, then checks the services.
  useEffect(() => {
    setRefreshing(true);
    void load()
      .then(() => window.chiefbot.health.checkServices())
      .then(showServices, failed)
      .finally(() => setRefreshing(false));
    const timer = setInterval(() => void load(), RELOAD_MS);
    return () => clearInterval(timer);
  }, []);

  const refresh = () => {
    setRefreshing(true);
    void window.chiefbot.health
      .refresh()
      .then(show, failed)
      .finally(() => setRefreshing(false));
  };

  const checkService = (id: string) => {
    setChecking((current) => new Set(current).add(id));
    void window.chiefbot.health
      .checkService(id)
      .then(showServices, failed)
      .finally(() =>
        setChecking((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        }),
      );
  };

  const actions: ServiceActions = {
    checking: ({ id }) => refreshing || checking.has(id),
    onAdd: () => setDialog({ service: null }),
    onEdit: (service) => setDialog({ service }),
    onRemove: ({ id, name }) =>
      void window.chiefbot.health.removeService(id, name).then(async (removed) => {
        if (removed) await load();
      }, failed),
    onCheck: ({ id }) => checkService(id),
    onAsk,
  };

  return (
    <>
      <PaneHeader icon={<ActivityIcon className="size-4 text-muted-foreground" />} title="Health" note="Read-only checks: connections every 5 minutes, services when you open Health and on Refresh">
        {report !== null && (report.connections.length > 0 || report.services.length > 0) && (
          <Button size="icon-xs" variant="ghost" aria-label="Check again now" title="Check again now" aria-busy={refreshing} disabled={refreshing} onClick={refresh}>
            <RefreshCwIcon className={cn(refreshing && "motion-safe:animate-spin")} />
          </Button>
        )}
      </PaneHeader>
      {report === null ? (
        <PaneBody>{error ? <ErrorText message={error} /> : <Muted>Loading…</Muted>}</PaneBody>
      ) : (
        <HealthView report={report} now={now} error={error} onConnectApps={onConnectApps} onAsk={onAsk} services={actions} />
      )}
      {dialog && (
        <ServiceDialog
          service={dialog.service}
          onClose={() => setDialog(null)}
          onSaved={({ id }) => {
            setDialog(null);
            void load().then(() => checkService(id));
          }}
        />
      )}
    </>
  );
}

// The screen's body for a report, as of `now`. Exported for its tests.
export function HealthView({
  report,
  now,
  error = null,
  onConnectApps,
  onAsk,
  services,
}: {
  report: HealthReport;
  now: number;
  error?: string | null;
  onConnectApps: () => void;
  onAsk: ((text: string) => void) | null;
  services: ServiceActions;
}) {
  if (report.connections.length === 0 && report.services.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia>
            <ActivityIcon />
          </EmptyMedia>
          <EmptyTitle>Nothing to check yet</EmptyTitle>
          <EmptyDescription>
            Health checks {listOf(report.checkable)} for you every 5 minutes, without asking your bots, and your own services when you open it. Turn a
            connection on under Connect apps, or add a service.
          </EmptyDescription>
        </EmptyHeader>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onConnectApps}>
            Open Connect apps
          </Button>
          <Button size="sm" variant="outline" onClick={services.onAdd}>
            <PlusIcon />
            Add service
          </Button>
        </div>
      </Empty>
    );
  }
  // Every connection's latest check and every service environment's, for the headline.
  const latest = [...report.connections.map(({ latest }) => latest), ...report.services.flatMap(({ environments }) => environments.map(({ latest }) => latest))];
  const subject = listOf([...(report.connections.length > 0 ? ["connections"] : []), ...(report.services.length > 0 ? ["services"] : [])]);
  return (
    <PaneBody>
      <Overall latest={latest} subject={subject} now={now} />
      <ErrorText message={error} />
      {report.connections.map((connection) => (
        <ConnectionCard key={connection.name} connection={connection} now={now} onAsk={onAsk} />
      ))}
      <ServicesCard services={report.services} now={now} actions={services} />
    </PaneBody>
  );
}

const headline: Record<HealthStatus, string> = {
  ok: "Everything is healthy",
  degraded: "Something is degraded",
  down: "Something is down",
  unknown: "Some checks couldn't run",
};

// The worst latest status of every connection and service environment, big, with
// how many are in each status. While one is not checked yet, nothing better than
// "Checking" shows. `subject` names what is checked: "connections and services".
function Overall({ latest: all, subject, now }: { latest: Array<{ status: HealthStatus; at: number } | null>; subject: string; now: number }) {
  const latest = all.filter((check) => check !== null);
  const waiting = all.length - latest.length;
  const worst = latest.length > 0 ? worstStatus(latest.map(({ status }) => status)) : null;
  const status = waiting > 0 && (worst === null || worst === "ok") ? null : worst;
  const counts = (["down", "degraded", "unknown", "ok"] as const)
    .map((each) => [each, latest.filter(({ status }) => status === each).length] as const)
    .filter(([, count]) => count > 0)
    .map(([each, count]) => `${count} ${statusLabel[each].toLowerCase()}`);
  const last = Math.max(...latest.map(({ at }) => at));
  const notes = [...counts, ...(waiting > 0 ? [`${waiting} not checked yet`] : []), ...(latest.length > 0 ? [`checked ${ago(last, now)}`] : [])];
  return (
    <section className="flex items-center gap-4 px-1">
      {status ? <StatusIcon status={status} className="size-9" /> : <RefreshCwIcon aria-hidden className="size-9 text-muted-foreground" />}
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="font-semibold text-3xl text-foreground tracking-tight">{status ? headline[status] : `Checking your ${subject}`}</h2>
        <p className="text-muted-foreground text-xs tabular-nums">{notes.join(" · ")}</p>
      </div>
    </section>
  );
}

// A connection's card: its status and when it was checked, what the check
// said, the last 24 hours as a bar, and each problem with Ask my bot.
function ConnectionCard({ connection, now, onAsk }: { connection: ConnectionHealth; now: number; onAsk: ((text: string) => void) | null }) {
  const { title, latest, history } = connection;
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2.5">
        <h3 className="min-w-0 truncate font-medium text-sm">{title}</h3>
        <Badge variant={latest ? badgeVariant[latest.status] : "outline"}>{latest ? statusLabel[latest.status] : "Not checked yet"}</Badge>
        {latest && <span className="ms-auto shrink-0 text-muted-foreground text-xs tabular-nums">Checked {ago(latest.at, now)}</span>}
      </div>
      <p className="text-muted-foreground text-xs">{latest?.summary ?? "The first check runs within a minute of turning it on."}</p>
      <StatusBar history={history} now={now} />
      {latest && latest.items.length > 0 && (
        <ul className="flex flex-col border-t">
          {latest.items.map((item, index) => (
            <ProblemRow key={index} item={item} onAsk={onAsk && (() => onAsk(askText(title, item)))} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ProblemRow({ item, onAsk }: { item: HealthItem; onAsk: (() => void) | null }) {
  return (
    <li className="flex items-start gap-3 border-b py-2.5 last:border-b-0 last:pb-0">
      <StatusIcon status={item.status} className="mt-0.5 size-4" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-foreground text-sm leading-snug">
          <span className="sr-only">{statusLabel[item.status]}: </span>
          {item.title}
        </span>
        {(item.detail || item.url) && (
          <span className="text-muted-foreground text-xs leading-relaxed">
            {item.detail}
            {item.url && (
              <a className="ms-1.5 inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline" href={item.url} target="_blank" rel="noreferrer">
                Details
                <ExternalLinkIcon aria-hidden className="size-3" />
              </a>
            )}
          </span>
        )}
      </div>
      <Button size="xs" variant="outline" disabled={!onAsk} title={onAsk ? "Open a bot's chat with this problem written in" : "Create a bot first"} onClick={onAsk ?? undefined}>
        <MessageSquareIcon />
        Ask my bot
      </Button>
    </li>
  );
}

// The message Ask my bot writes into the chat: the problem, and what to do.
export const askText = (connection: string, { title, detail }: HealthItem) =>
  `My ${connection} health check says: ${title}${detail ? `\n${detail}` : ""}\n\nFind out why, and tell me what to do about it.`;

// The last 24 hours of a connection's checks, as T3's usage share bar draws its
// segments: one per check, joined with its neighbours of the same status. The track shows where there was no check.
function StatusBar({ history, now }: { history: ConnectionHealth["history"]; now: number }) {
  const segments = timeline(history, now);
  const healthy = history.length > 0 ? `${Math.round((history.filter(({ status }) => status === "ok").length / history.length) * 100)}% healthy` : "";
  // What the colours say, for screen readers: each segment's status and times.
  const label =
    segments.length > 0
      ? `Last 24 hours, ${healthy}: ${segments.map(({ status, from, to }) => `${statusLabel[status].toLowerCase()} ${clock(from)} to ${clock(to)}`).join(", ")}`
      : "No checks in the last 24 hours";
  return (
    <div className="flex flex-col gap-1.5">
      <div role="img" aria-label={label} className="relative h-2.5 overflow-hidden rounded-full bg-muted">
        {segments.map(({ status, from, to, checks, summary }) => (
          <span
            key={from}
            title={`${statusLabel[status]} · ${clock(from)} to ${clock(to)} · ${checks === 1 ? "1 check" : `${checks} checks`}\n${summary}`}
            className={cn("absolute inset-y-0 rounded-[2px]", barColor[status])}
            style={{ left: `calc(${percent(from - (now - HEALTH_KEEP_MS))} + 1px)`, width: `max(3px, calc(${percent(to - from)} - 2px))` }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[0.6875rem] text-muted-foreground tabular-nums">
        <span>24 h ago</span>
        <span>{healthy}</span>
        <span>Now</span>
      </div>
    </div>
  );
}

const percent = (ms: number) => `${(ms / HEALTH_KEEP_MS) * 100}%`;

export type Segment = { status: HealthStatus; from: number; to: number; checks: number; summary: string };

// The bar's segments for `history` (oldest first) as of `now`: the checks of the
// last HEALTH_KEEP_MS. A check stands for the interval before it (up to
// HEALTH_INTERVAL_MS, back to the check before), and joins the segment before
// when that has its status and reaches it, so a gap with no checks (control was
// off) stays empty.
export function timeline(history: ConnectionHealth["history"], now: number): Segment[] {
  const start = now - HEALTH_KEEP_MS;
  const shown = history.filter(({ at }) => at > start);
  const segments: Segment[] = [];
  shown.forEach(({ at, status, summary }, index) => {
    const previous = shown[index - 1]?.at ?? -Infinity;
    const from = Math.max(at - HEALTH_INTERVAL_MS, previous, start);
    const last = segments.at(-1);
    if (last && last.status === status && last.to >= from) segments[segments.length - 1] = { ...last, to: at, checks: last.checks + 1, summary };
    else segments.push({ status, from, to: at, checks: 1, summary });
  });
  return segments;
}

