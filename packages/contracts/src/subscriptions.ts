import { z } from "zod";
import { CallIdentity, ConnectorName } from "./connectors.ts";
import { ProjectId, SubscriptionId } from "./ids.ts";

// The shortest and default wait between two polls of a subscription, in seconds.
export const MIN_POLL_SECONDS = 60;
export const DEFAULT_POLL_SECONDS = 300;

const PollSeconds = z.number().int().min(MIN_POLL_SECONDS).max(86_400).default(DEFAULT_POLL_SECONDS);

// What a project listens to (body of POST /projects/:id/subscriptions). Each
// event it sees becomes one task in the ledger and one message to the coordinator.
//   ci-status    a CI run on `branch` that fails, polled through a remote connector
//                the project declares, whose MCP server lists workflow runs
//                (GitHub's `actions_list`, as the github-actions preset offers)
//   issue-query  a new or updated result of `query` on a remote issue-tracker
//                connector (GitHub's `search_issues`, or Jira's
//                `searchJiraIssuesUsingJql` with `site`, the Atlassian site or cloud ID)
//   schedule     `prompt` at each due time of `cron` read in `timezone`, as a routine
// Polls run every `intervalSeconds`. The first one only notes what is already
// there: events are what changes after the subscription is added.
export const SubscriptionInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ci-status"),
    connector: ConnectorName.default("github-actions"),
    branch: z.string().trim().min(1).max(200),
    intervalSeconds: PollSeconds,
  }),
  z.strictObject({
    kind: z.literal("issue-query"),
    connector: ConnectorName,
    query: z.string().trim().min(1).max(2000),
    site: z.string().trim().min(1).max(200).optional(),
    intervalSeconds: PollSeconds,
  }),
  z.strictObject({
    kind: z.literal("schedule"),
    prompt: z.string().trim().min(1).max(20_000),
    cron: z.string().trim().min(1).max(200),
    timezone: z.string().trim().min(1).max(100),
  }),
]);
export type SubscriptionInput = z.infer<typeof SubscriptionInput>;

// A project's subscription. `addedBy` is the login of the member who added it:
// events go to their chat with the coordinator, and a personal connector is
// polled as them. `identity` is whose credential the last poll used (null before
// the first poll, and for schedules). Times are epoch milliseconds.
export const Subscription = z.object({
  id: SubscriptionId,
  projectId: ProjectId,
  addedBy: z.string(),
  source: SubscriptionInput,
  nextDueAt: z.number().int(),
  lastPolledAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  identity: CallIdentity.nullable(),
  // Events that became tasks so far.
  events: z.number().int(),
});
export type Subscription = z.infer<typeof Subscription>;
