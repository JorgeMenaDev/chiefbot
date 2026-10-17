import { z } from "zod";
import { HandoffId, ProjectId } from "./ids.ts";
import { TaskLink, TaskStatus } from "./projects.ts";

// A chief of staff is a person's own bot. It hands work to a project of one of
// its owner's workspaces and watches it; it never manages the project's workers.
// Each handoff becomes one task in the project's ledger, which the project's
// coordinator gets as a message in the requester's own chat with it.

// What the chief asked for. `title`, `status` and `links` are the linked task's, read
// from the ledger. `requestedBy` is the chief's owner's login. Times are epoch milliseconds.
export const Handoff = z.object({
  id: HandoffId,
  projectId: ProjectId,
  project: z.string().describe("The project's name"),
  title: z.string(),
  requestedBy: z.string(),
  request: z.string(),
  acceptance: z.string(),
  taskNumber: z.number().int().min(1),
  status: TaskStatus,
  links: z.array(TaskLink),
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
export const HandoffStatusArgs = z.object({
  handoff: HandoffId.optional().describe("One handoff's id; left out, all of them"),
});

// Body of POST /worker/:botId/chief-tools: one tool call of the bot's running turn.
// Its answer, as JSON: list_projects → Project[]; send_to_project → Handoff;
// handoff_status → Handoff[] (oldest first), or one Handoff when it names one.
export const ChiefToolCall = z.discriminatedUnion("tool", [
  ListProjectsArgs.extend({ tool: z.literal("list_projects") }),
  SendToProjectArgs.extend({ tool: z.literal("send_to_project") }),
  HandoffStatusArgs.extend({ tool: z.literal("handoff_status") }),
]);
export type ChiefToolCall = z.infer<typeof ChiefToolCall>;
