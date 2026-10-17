import { afterEach, expect, test } from "bun:test";
import {
  ConnectorCall,
  Project,
  Subscription,
  Task,
  Workspace,
  WorkspaceInvite,
  type ConnectorInput,
  type SubscriptionInput,
} from "@chiefbot/contracts";
import type { z } from "zod";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { fakeClock } from "./clock.ts";
import { startFakeMcpServer } from "./connectors/fakeMcpServer.ts";
import type { SecretStore } from "./secrets/secretStore.ts";
import { atCleanUp, cleanUp, eventually, startTestControl, type TestUser } from "./testControl.ts";

afterEach(cleanUp);

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } };
// 15 Oct 2026, 07:00 UTC: 08:00 in London (BST).
const start = Date.parse("2026-10-15T07:00:00Z");
const minute = 60_000;

// A CI run as GitHub's actions_list answers it.
const run = (id: number, conclusion: string | null, branch = "main") => ({
  id,
  name: "CI",
  run_number: id,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  head_branch: branch,
  html_url: `https://github.com/octo-org/shop/actions/runs/${id}`,
});

// Control on a fake clock with a SQLite file and secrets that survive a restart;
// a workspace owned by the signed-in user with octo-friend as its member; and a
// project octo-org/shop declaring the `connectors`, each served by one fake MCP server.
async function team(connectors: string[]) {
  const time = fakeClock(start);
  const values = new Map<string, string>();
  const secrets: SecretStore = {
    get: async (name) => values.get(name) ?? null,
    put: async (name, value) => void values.set(name, value),
    delete: async (name) => void values.delete(name),
  };
  const control = await startTestControl({ persistent: true, clock: time.clock, secrets, idleStopMinutes: 24 * 60 });
  const owner = control.user;
  const workspace = Workspace.parse(await (await owner.api("POST", "/workspaces", { name: "Platform team" })).json());
  await owner.api("POST", `/workspaces/${workspace.id}/invites`, { login: friend.login });
  const guest = await control.signIn(friend);
  const [invite] = WorkspaceInvite.array().parse(await (await guest.api("GET", "/invites")).json());
  await guest.api("POST", `/invites/${invite?.id}/accept`);
  control.github.createRepo("octo-org/shop", { "chiefbot.project.yaml": `connectors: [${connectors.join(", ")}]\n` });
  const project = Project.parse(await (await owner.api("POST", `/workspaces/${workspace.id}/projects`, { repo: "octo-org/shop" })).json());
  const connectorsPath = `/workspaces/${workspace.id}/connectors`;

  // Defines a remote connector served by `server`.
  const define = async (input: Omit<ConnectorInput, "server" | "scope">, server: { url: string }) => {
    const res = await owner.api("POST", connectorsPath, { ...input, server: { kind: "remote", url: server.url }, scope: "" });
    if (res.status !== 201) throw new Error(`define failed: ${res.status} ${await res.text()}`);
  };
  const subscribe = async (member: TestUser, input: z.input<typeof SubscriptionInput>) => {
    const res = await member.api("POST", `/projects/${project.id}/subscriptions`, input);
    if (res.status !== 201) throw new Error(`subscribe failed: ${res.status} ${await res.text()}`);
    return Subscription.parse(await res.json());
  };
  const subscriptions = async () =>
    Subscription.array().parse(await (await owner.api("GET", `/projects/${project.id}/subscriptions`)).json());
  const tasks = async () => Task.array().parse(await (await owner.api("GET", `/projects/${project.id}/tasks`)).json());
  const calls = async () => ConnectorCall.array().parse(await (await owner.api("GET", `/projects/${project.id}/connector-calls`)).json());
  // The member's messages to the coordinator so far.
  const messages = async (member: TestUser) =>
    (await member.watchProjectChat(project.id).settled()).flatMap(({ event }) => (event.type === "user-message" ? [event.text] : []));
  // Moves the clock on, then waits for every subscription to have polled since.
  const advance = async (ms: number) => {
    time.advance(ms);
    const now = time.clock.now();
    await eventually(async () => (await subscriptions()).every(({ source, lastPolledAt }) => source.kind === "schedule" || (lastPolledAt ?? 0) > now - ms));
  };
  return { ...control, time, owner, guest, workspace, project, connectorsPath, define, subscribe, subscriptions, tasks, calls, messages, advance };
}

test("a failing CI run on the branch becomes one task and one coordinator message, once, even across a restart", async () => {
  let runs = [run(1, "failure"), run(2, "success")];
  const actions = startFakeMcpServer({
    tools: { actions_list: ({ workflow_runs_filter }) => ({ total_count: runs.length, workflow_runs: runs, filter: workflow_runs_filter }) },
  });
  atCleanUp(actions.stop);
  const { owner, define, connectorsPath, subscribe, subscriptions, tasks, calls, messages, advance, restart } = await team(["github-actions"]);
  await define({ name: "github-actions", title: "GitHub Actions", auth: "workspace-secret" }, actions);
  await owner.api("PUT", `${connectorsPath}/github-actions/secret`, { token: "ci-service-token" });

  const subscription = await subscribe(owner, { kind: "ci-status", connector: "github-actions", branch: "main", intervalSeconds: 60 });
  // The first poll only notes the runs already there.
  await advance(1000);
  expect(await tasks()).toEqual([]);

  runs = [run(3, "failure"), run(4, null), run(5, "failure", "feature"), ...runs];
  await advance(minute);
  await advance(minute);
  restart();
  await advance(minute);

  const [task] = await tasks();
  expect((await tasks()).length).toBe(1);
  expect(task).toMatchObject({ number: 1, title: "CI failed on main: CI #3", requestedBy: "octo-user", status: "open" });
  expect(task?.links).toEqual([{ kind: "url", url: "https://github.com/octo-org/shop/actions/runs/3" }]);
  const sent = await messages(owner);
  expect(sent.length).toBe(1);
  expect(sent[0]).toContain("task #1");
  expect(sent[0]).toContain("https://github.com/octo-org/shop/actions/runs/3");
  expect((await subscriptions())[0]).toMatchObject({ id: subscription.id, identity: "workspace", lastError: null, events: 1 });
  // Each poll is in the call log, as the workspace's credential.
  expect(actions.calls.every(({ tool, authorization }) => tool === "actions_list" && authorization === "Bearer ci-service-token")).toBe(true);
  expect((await calls()).at(-1)).toMatchObject({ connector: "github-actions", tool: "actions_list", identity: "workspace", requester: "octo-user", run: subscription.id });
});

test("an issue query polls as the adding member's own account for a personal connector; a new or updated result is one task in their chat", async () => {
  let items = [{ number: 7, title: "Checkout is slow", html_url: "https://github.com/octo-org/shop/issues/7", updated_at: "2026-10-15T06:00:00Z" }];
  const queries: unknown[] = [];
  const github = startFakeMcpServer({
    tools: {
      search_issues: (args) => {
        queries.push(args.query);
        return { total_count: items.length, items };
      },
    },
  });
  atCleanUp(github.stop);
  const { owner, guest, define, connectorsPath, subscribe, subscriptions, tasks, calls, messages, advance } = await team(["github"]);
  await define({ name: "github", title: "GitHub", auth: "personal-oauth" }, github);
  await guest.api("PUT", `${connectorsPath}/github/token`, { token: "friend-token" });

  await subscribe(guest, { kind: "issue-query", connector: "github", query: "repo:octo-org/shop label:bug is:open", intervalSeconds: 60 });
  await advance(1000);
  items = [
    { ...items[0]!, updated_at: "2026-10-15T07:00:30Z" },
    { number: 8, title: "Refunds fail", html_url: "https://github.com/octo-org/shop/issues/8", updated_at: "2026-10-15T07:00:40Z" },
  ];
  await advance(minute);
  await advance(minute);

  expect((await tasks()).map(({ title, requestedBy }) => [title, requestedBy])).toEqual([
    ["Issue #7: Checkout is slow", "octo-friend"],
    ["Issue #8: Refunds fail", "octo-friend"],
  ]);
  expect((await messages(guest)).length).toBe(2);
  expect(await messages(owner)).toEqual([]);
  expect(queries).toEqual(Array(3).fill("repo:octo-org/shop label:bug is:open"));
  expect(github.calls.every(({ authorization }) => authorization === "Bearer friend-token")).toBe(true);
  expect((await subscriptions())[0]).toMatchObject({ addedBy: "octo-friend", identity: "personal", events: 2 });
  expect((await calls()).at(-1)).toMatchObject({ tool: "search_issues", identity: "personal", requester: "octo-friend" });
});

test("a schedule becomes one task and message per due time, across a restart", async () => {
  const { owner, time, subscribe, subscriptions, tasks, messages, restart } = await team([]);
  const hourToNine = Date.parse("2026-10-15T08:00:00Z") - start;

  const schedule = await subscribe(owner, { kind: "schedule", prompt: "Write the weekly summary\nfrom the ledger", cron: "0 9 * * *", timezone: "Europe/London" });
  expect(schedule.nextDueAt).toBe(start + hourToNine);
  time.advance(hourToNine);
  await eventually(async () => (await tasks()).length === 1);
  restart();
  time.advance(minute);
  await Bun.sleep(50);
  expect((await tasks()).length).toBe(1);
  time.advance(24 * 3600_000);
  await eventually(async () => (await tasks()).length === 2);

  expect((await tasks()).map(({ title, detail }) => [title, detail])).toEqual(Array(2).fill(["Scheduled: Write the weekly summary", "Write the weekly summary\nfrom the ledger"]));
  expect((await messages(owner)).length).toBe(2);
  expect((await subscriptions())[0]).toMatchObject({ events: 2, nextDueAt: start + hourToNine + 2 * 24 * 3600_000 });
});

test("a subscription needs a remote connector the project declares and a schedule control can run; any member removes it", async () => {
  const { owner, guest, project, define, subscribe, subscriptions, signIn } = await team(["github-actions", "jira"]);
  await define({ name: "github-actions", title: "GitHub Actions", auth: "workspace-secret" }, { url: "https://ci.example.com/mcp" });
  const refusal = async (input: unknown) => {
    const res = await owner.api("POST", `/projects/${project.id}/subscriptions`, input);
    return [res.status, ((await res.json()) as { error: string }).error];
  };

  expect(await refusal({ kind: "ci-status", branch: "main", intervalSeconds: 10 })).toEqual([400, "invalid_subscription"]);
  expect(await refusal({ kind: "issue-query", connector: "jira", query: "project = SHOP" })).toEqual([400, "invalid_subscription"]);
  expect(await refusal({ kind: "issue-query", connector: "linear", query: "bugs" })).toEqual([400, "invalid_subscription"]);
  expect(await refusal({ kind: "schedule", prompt: "Hi", cron: "daily", timezone: "Europe/London" })).toEqual([400, "invalid_schedule"]);
  const ci = await subscribe(owner, { kind: "ci-status", branch: "main" });
  expect(ci.source).toEqual({ kind: "ci-status", connector: "github-actions", branch: "main", intervalSeconds: 300 });
  const stranger = await signIn({ id: 6161, login: "octo-stranger", copilot: null });
  expect((await stranger.api("GET", `/projects/${project.id}/subscriptions`)).status).toBe(404);
  expect((await guest.api("DELETE", `/projects/${project.id}/subscriptions/${ci.id}`)).status).toBe(204);
  expect(await subscriptions()).toEqual([]);
});
