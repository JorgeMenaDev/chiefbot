import { SubscriptionInput, type Project, type Subscription, type SubscriptionId, type User } from "@chiefbot/contracts";
import { z } from "zod";
import type { Clock } from "@chiefbot/worker/clock";
import type { connectorHost } from "./connectors/connectors.ts";
import { apiError, bearer, unauthorized } from "./http.ts";
import type { projectHost } from "./projects.ts";
import { nextDueAt } from "./schedule.ts";
import type { openStore } from "./store.ts";
import type { DuePoll, HandledEvent, SeenEvent } from "./subscriptionStore.ts";

// How often control looks for due subscriptions.
export const TICK_MS = 1000;

// Subscriptions: what a project listens to. Control polls CI runs and issue
// queries through the project's remote connectors (connectors.ts controlSession:
// the workspace's credential, or the adding member's own for a personal
// connector, each call in the call log) and fires schedules on the routines'
// cron engine. Each event has a stable id, stored with the subscription, so it
// becomes exactly one ledger task and one coordinator message in the adding
// member's chat, across restarts. A subscription whose member left the
// workspace pauses.
//
// Member routes (a session; 404 to anyone outside the project's workspace):
//   GET    /projects/:id/subscriptions                   → Subscription[]
//   POST   /projects/:id/subscriptions                   body SubscriptionInput → 201 Subscription
//                                                        (400 invalid_subscription, invalid_schedule)
//   DELETE /projects/:id/subscriptions/:subscriptionId   → 204
export function subscriptionHost({
  store,
  clock,
  connectors,
  projects,
}: {
  store: ReturnType<typeof openStore>;
  clock: Clock;
  connectors: Pick<ReturnType<typeof connectorHost>, "controlSession">;
  projects: Pick<ReturnType<typeof projectHost>, "queued" | "ledgerChanged">;
}) {
  let stopped = false;
  let cancelTick = () => {};
  // Polls in flight: a slow one is not started again.
  const polling = new Set<SubscriptionId>();

  // Members see the new tasks and messages, and the coordinators get them.
  const announce = (handled: HandledEvent[]) => {
    for (const { projectId, userId, queued } of handled) projects.queued(projectId, userId, queued);
    for (const projectId of new Set(handled.map(({ projectId }) => projectId))) projects.ledgerChanged(projectId);
  };

  // What one poll sees: the connector's answer as events.
  async function check({ id, projectId, userId, source }: DuePoll) {
    const project = store.projects.project(projectId);
    if (!project) throw new Error("The project is gone.");
    const session = await connectors.controlSession(projectId, source.connector, userId, id);
    if (source.kind === "ci-status") {
      const [owner, repo] = project.repo.split("/");
      const runs = await session.callTool("actions_list", {
        method: "list_workflow_runs",
        owner,
        repo,
        workflow_runs_filter: { branch: source.branch },
        perPage: 30,
      });
      return { identity: session.identity, events: failedRuns(runs, source.branch) };
    }
    const tools = await session.listTools();
    const search = issueSearches.find(({ tool }) => tools.includes(tool));
    if (!search) throw new Error(`${source.connector} offers no issue search control knows (${issueSearches.map(({ tool }) => tool).join(", ")}).`);
    const args = search.args(source.query, source.site);
    if (typeof args === "string") throw new Error(args);
    return { identity: session.identity, events: issueResults(await session.callTool(search.tool, args), source.site) };
  }

  async function poll(due: DuePoll, at: number) {
    polling.add(due.id);
    const result = await check(due).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    polling.delete(due.id);
    if (!stopped) announce(store.subscriptions.polled(due.id, at, result) ?? []);
  }

  function tick() {
    if (stopped) return;
    try {
      const now = clock.now();
      const { handled, polls } = store.subscriptions.claimDue(now);
      announce(handled);
      for (const due of polls) if (!polling.has(due.id)) void poll(due, now);
    } catch (error) {
      console.error("subscription tick failed", error);
    }
    cancelTick = clock.setTimeout(tick, TICK_MS);
  }

  // Runs a /projects/:id route for a signed-in member of the project's workspace; 401 or 404 otherwise.
  const member =
    <Req extends Request & { params: { id: string } }>(handle: (user: User, project: Project, req: Req) => Response | Promise<Response>) =>
    (req: Req) => {
      const user = store.userForSession(bearer(req));
      if (!user) return unauthorized();
      const found = store.projects.projectFor(user.id, req.params.id);
      if (!found) return apiError(404, "not_found");
      return handle(user, found.project, req);
    };

  // When a new subscription is first due, or why control refuses it.
  function firstDueAt(project: Project, source: SubscriptionInput): number | Response {
    if (source.kind === "schedule") {
      try {
        const next = nextDueAt(source.cron, source.timezone, clock.now());
        if (next !== null) return next;
      } catch {}
      return apiError(400, "invalid_schedule");
    }
    const connector = store.connectors.get(project.workspaceId, source.connector);
    if (!project.file.connectors.includes(source.connector) || connector?.server.kind !== "remote") {
      return apiError(400, "invalid_subscription", `${source.connector} must be a remote connector of the workspace that ${project.name}'s chiefbot.project.yaml declares`);
    }
    return clock.now();
  }

  const routes = {
    "/projects/:id/subscriptions": {
      GET: member((_user, project, _req: Bun.BunRequest<"/projects/:id/subscriptions">) =>
        Response.json(store.subscriptions.of(project.id) satisfies Subscription[]),
      ),
      POST: member(async (user, project, req: Bun.BunRequest<"/projects/:id/subscriptions">) => {
        const body = SubscriptionInput.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_subscription", z.prettifyError(body.error));
        const due = firstDueAt(project, body.data);
        if (due instanceof Response) return due;
        return Response.json(store.subscriptions.create(project.id, user.id, body.data, due) satisfies Subscription, { status: 201 });
      }),
    },
    "/projects/:id/subscriptions/:subscriptionId": {
      DELETE: member((_user, project, req: Bun.BunRequest<"/projects/:id/subscriptions/:subscriptionId">) =>
        store.subscriptions.delete(project.id, req.params.subscriptionId) ? new Response(null, { status: 204 }) : apiError(404, "not_found"),
      ),
    },
  };

  return {
    routes,
    // Starts polling. Call once the server is up: events are published through it.
    start: tick,
    stop() {
      stopped = true;
      cancelTick();
    },
  };
}

// The issue searches control can run, by the tool an MCP server offers. Data,
// not code paths: `args` builds the tool's arguments, or says what is missing.
//   search_issues             GitHub's MCP server: GitHub's issue search syntax
//   searchJiraIssuesUsingJql  Atlassian's MCP server: JQL, on the Jira site `site`
const issueSearches: Array<{ tool: string; args: (query: string, site: string | undefined) => Record<string, unknown> | string }> = [
  { tool: "search_issues", args: (query) => ({ query, sort: "updated", order: "desc", perPage: 50 }) },
  {
    tool: "searchJiraIssuesUsingJql",
    args: (jql, site) => (site === undefined ? "A Jira query needs the site (your-site.atlassian.net or its cloud ID)." : { jql, cloudId: site, maxResults: 50 }),
  },
];

// The first array under `key` in `value`, searching nested objects too: servers
// wrap the same list differently (a raw API answer, or a typed copy of it).
function arrayAt(value: unknown, key: string, depth = 0): unknown[] | null {
  if (depth > 4 || typeof value !== "object" || value === null) return null;
  const record = z.record(z.string(), z.unknown()).safeParse(value);
  if (!record.success) return null;
  const direct = record.data[key];
  if (Array.isArray(direct)) return direct;
  for (const nested of Object.values(record.data)) {
    const found = arrayAt(nested, key, depth + 1);
    if (found) return found;
  }
  return null;
}

// A workflow run as GitHub reports it; only the fields control reads.
const WorkflowRun = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().nullish(),
  run_number: z.number().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  head_branch: z.string().nullish(),
  html_url: z.string().nullish(),
});
const failing = new Set(["failure", "timed_out", "startup_failure"]);

// Each completed run on `branch` that failed. Its id is the run's id and conclusion.
function failedRuns(answer: unknown, branch: string): SeenEvent[] {
  return (arrayAt(answer, "workflow_runs") ?? []).flatMap((value) => {
    const run = WorkflowRun.safeParse(value);
    if (!run.success || run.data.status !== "completed" || !failing.has(run.data.conclusion ?? "")) return [];
    if (run.data.head_branch && run.data.head_branch !== branch) return [];
    const { id, name, run_number, conclusion, html_url } = run.data;
    const label = `${name ?? "CI"}${run_number ? ` #${run_number}` : ""}`;
    const url = html_url ?? null;
    return [
      {
        id: `ci:${id}:${conclusion}`,
        title: `CI failed on ${branch}: ${label}`,
        detail: `The ${label} run on ${branch} finished with ${conclusion}${url ? `: ${url}` : ""}.`,
        url,
      },
    ];
  });
}

// An issue as GitHub (number, html_url, updated_at) or Jira (key, fields) reports it.
const Issue = z.object({
  key: z.string().optional(),
  number: z.number().optional(),
  id: z.union([z.number(), z.string()]).optional(),
  title: z.string().optional(),
  html_url: z.string().optional(),
  updated_at: z.string().optional(),
  fields: z.object({ summary: z.string().optional(), updated: z.string().optional() }).optional(),
});

// Each result of an issue query. Its id is the issue and when it was last
// updated, so an update is a new event.
function issueResults(answer: unknown, site: string | undefined): SeenEvent[] {
  return (arrayAt(answer, "items") ?? arrayAt(answer, "issues") ?? []).flatMap((value) => {
    const issue = Issue.safeParse(value);
    if (!issue.success) return [];
    const { key, number, id, title, html_url, updated_at, fields } = issue.data;
    const name = key ?? (number === undefined ? undefined : `#${number}`) ?? (id === undefined ? undefined : String(id));
    if (name === undefined) return [];
    const host = site?.includes(".") ? site.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null;
    const url = html_url ?? (key && host ? `https://${host}/browse/${key}` : null);
    const summary = title ?? fields?.summary ?? "";
    return [
      {
        id: `issue:${html_url ?? name}:${updated_at ?? fields?.updated ?? ""}`,
        title: `Issue ${name}: ${summary}`,
        detail: `${name} ${summary} is new or updated in the query's results${url ? `: ${url}` : ""}.`,
        url,
      },
    ];
  });
}
