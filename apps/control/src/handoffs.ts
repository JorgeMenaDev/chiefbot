import { ChiefToolCall, type BotId, type Handoff, type Project, type User } from "@chiefbot/contracts";
import { apiError } from "./http.ts";
import type { projectHost } from "./projects.ts";
import type { openStore } from "./store.ts";
import { botTurn, heldTurn } from "./turnKeys.ts";

// Handoffs: a person's chief of staff (their own bot) hands work to a project
// of one of their workspaces, then watches it. Each handoff becomes a task in
// the project's ledger, which the coordinator gets as a message in the
// requester's own chat with it, through the project's scheduler. The chief
// never manages the project's workers: it only starts and watches.
//
//   POST /worker/:botId/chief-tools  bearer the key of that bot's running turn (403 invalid_turn_key
//                                    otherwise), body ChiefToolCall → its answer
//                                    (handoffs.ts in contracts). A chief sees only projects of the
//                                    workspaces its owner is a member of: 404 not_found for any other.
export function chiefHost({
  store,
  projects,
}: {
  store: ReturnType<typeof openStore>;
  projects: Pick<ReturnType<typeof projectHost>, "deliver" | "ledgerChanged">;
}) {
  // One chief tool call of the bot, whose owner is `owner`.
  function runTool(botId: BotId, owner: User, call: ChiefToolCall): Response {
    switch (call.tool) {
      case "list_projects":
        return Response.json(
          store.workspaces.workspacesFor(owner.id).flatMap(({ id }) => store.projects.projectsIn(id)) satisfies Project[],
        );
      case "send_to_project": {
        const found = store.projects.projectFor(owner.id, call.project);
        if (!found) return apiError(404, "not_found", `No project ${call.project} in your owner's workspaces`);
        const handoff = store.handoffs.create(botId, { userId: owner.id, login: owner.login }, found.project.id, call);
        projects.ledgerChanged(handoff.projectId);
        projects.deliver(handoff.projectId, owner.id, toCoordinator(handoff, call.title));
        return Response.json(handoff satisfies Handoff);
      }
      case "handoff_status": {
        const handoffs = store.handoffs.of(botId, call.handoff);
        if (!call.handoff) return Response.json(handoffs satisfies Handoff[]);
        const [handoff] = handoffs;
        return handoff ? Response.json(handoff satisfies Handoff) : apiError(404, "not_found", `No handoff ${call.handoff}`);
      }
    }
  }

  const routes = {
    "/worker/:botId/chief-tools": {
      POST: async (req: Bun.BunRequest<"/worker/:botId/chief-tools">) => {
        const bot = heldTurn(store.turnKeys, req, botTurn(req.params.botId));
        if (bot instanceof Response) return bot;
        const call = ChiefToolCall.safeParse(await req.json().catch(() => null));
        if (!call.success) {
          const issues = call.error.issues.map(({ path, message }) => (path.length > 0 ? `${path.join(".")}: ${message}` : message));
          return apiError(400, "invalid_tool_call", issues.join("; "));
        }
        return runTool(bot.botId, store.user(bot.userId), call.data);
      },
    },
  };

  return { routes };
}

// The coordinator's message for a handoff, in the requester's chat with it.
function toCoordinator({ requestedBy, taskNumber, request, acceptance }: Handoff, title: string) {
  return [
    `${requestedBy}'s chief of staff handed this to the project. It is task #${taskNumber} in the ledger: work on that task, and do not add another for it.`,
    "",
    title,
    request,
    "",
    `Done when: ${acceptance}`,
    "",
    `Set task #${taskNumber} to needs_input when you need ${requestedBy}'s answer, and to done once that holds, with links to what it delivered.`,
  ].join("\n");
}
