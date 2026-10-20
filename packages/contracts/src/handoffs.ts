import { z } from "zod";
import { HandoffId, ProjectId, WorkspaceId } from "./ids.ts";
import { TaskLink, TaskStatus } from "./projects.ts";
import { TaskWorker } from "./taskWorkers.ts";

// A chief of staff is a person's own bot. It hands work to a project of one of
// its owner's workspaces and watches it; it never manages the project's workers.
// Each handoff becomes one task in the project's ledger, which the project's
// coordinator gets as a message in the requester's own chat with it.

// What the chief asked for. `title`, `status`, `question` and `links` are the
// linked task's, read from the ledger, and `workers` its workers. `summary` is
// the coordinator's last reply to a message of the handoff (its request or a
// follow-up). `requestedBy` is the chief's owner's login. Times are epoch milliseconds.
export const Handoff = z.object({
  id: HandoffId,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  project: z.string().describe("The project's name"),
  title: z.string(),
  requestedBy: z.string(),
  request: z.string(),
  acceptance: z.string(),
  taskNumber: z.number().int().min(1),
  status: TaskStatus,
  question: z.string().nullable().describe("What the project needs your owner to answer, while the task needs input"),
  links: z.array(TaskLink),
  workers: z.array(TaskWorker.pick({ id: true, state: true, result: true, pullRequest: true })),
  summary: z.string().nullable().describe("The project coordinator's last reply about this work"),
  createdAt: z.number(),
});
export type Handoff = z.infer<typeof Handoff>;

// The chief's tools, by name. Each argument schema is also what the model sees.
export const ListProjectsArgs = z.object({});
export const SendToProjectArgs = z.object({
  project: ProjectId.describe("The project's id, from list_projects"),
  title: z.string().trim().min(1).max(200).describe("A short, specific title for the project's task"),
  request: z.string().trim().min(1).max(20_000).describe("What your owner wants from the project, with what the team needs to know"),
  acceptance: z.string().trim().min(1).max(2_000).describe("How your owner will know it is done, e.g. a merged pull request that does X"),
});
export const MessageProjectArgs = z.object({
  handoff: HandoffId.describe("The handoff's id, from send_to_project or handoff_status"),
  message: z.string().trim().min(1).max(20_000).describe("The follow-up, or your owner's answer to the project's question"),
});
export const HandoffStatusArgs = z.object({
  handoff: HandoffId.optional().describe("One handoff's id; left out, all of them"),
});

// Body of POST /bots/:id/handoffs/:handoffId/messages: the owner's answer from
// the handoff's card in their chief's chat. `question` is the one the card showed
// when the answer was started (null for none): control refuses the answer (409
// question_changed) when the project asks something else by then. The desktop
// picks `deliveryId` for the answer's exact text and question: sent again
// unchanged it is delivered once, and control refuses other text under it (409
// delivery_reused).
export const ReplyToHandoffRequest = z.object({
  text: z.string().trim().min(1).max(20_000),
  question: z.string().max(2_000).nullable(),
  deliveryId: z.uuid(),
});
export type ReplyToHandoffRequest = z.infer<typeof ReplyToHandoffRequest>;

// Body of POST /worker/:botId/chief-tools: one tool call of the bot's running turn.
// Its answer, as JSON: list_projects → Project[]; send_to_project and message_project → Handoff;
// handoff_status → Handoff[] (oldest first), or one Handoff when it names one.
// message_project's `deliveryId` is not the model's: the chief sets it from the
// tool call's id, so a resent call delivers its message once. A handoff whose
// task is done or abandoned takes no follow-up (409 handoff_closed).
export const ChiefToolCall = z.discriminatedUnion("tool", [
  ListProjectsArgs.extend({ tool: z.literal("list_projects") }),
  SendToProjectArgs.extend({ tool: z.literal("send_to_project") }),
  MessageProjectArgs.extend({ tool: z.literal("message_project"), deliveryId: z.string().min(1).max(300) }),
  HandoffStatusArgs.extend({ tool: z.literal("handoff_status") }),
]);
export type ChiefToolCall = z.infer<typeof ChiefToolCall>;
