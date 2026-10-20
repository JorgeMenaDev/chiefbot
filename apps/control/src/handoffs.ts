import { ChiefToolCall, HandoffId, ReplyToHandoffRequest, type BotId, type Handoff, type Project, type User } from "@chiefbot/contracts";
import { apiError, bearer, unauthorized } from "./http.ts";
import type { projectHost } from "./projects.ts";
import type { openStore } from "./store.ts";
import type { taskWorkerHost } from "./taskWorkers.ts";
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
//   POST /bots/:id/handoffs/:handoffId/messages  a session of the bot's owner (404 for anyone else),
//                                    body ReplyToHandoffRequest → 204: the owner's answer from the
//                                    handoff's card, delivered as the chief's message_project is.
// A follow-up, from the chief or the card, names the question the task asks now (none while it
// asks none), else 409 question_changed. One to a handoff whose task is done or abandoned gets
// 409 handoff_closed, and one under a delivery id that carried another message or question 409
// delivery_reused.
export function chiefHost({
  store,
  projects,
  workers,
}: {
  store: ReturnType<typeof openStore>;
  projects: Pick<ReturnType<typeof projectHost>, "queued" | "ledgerChanged">;
  // handoff_status checks each task's current verdict on GitHub first.
  workers: Pick<ReturnType<typeof taskWorkerHost>, "refreshVerdicts">;
}) {
  // Sends a follow-up to the bot's handoff (handoffStore.ts followUp): the
  // owner's chat with the coordinator shows it, and the members the task's new
  // detail. The handoff, or the refusal to answer with.
  function followUp(
    botId: BotId,
    owner: User,
    handoffId: HandoffId,
    from: "chief" | "owner",
    delivery: { deliveryId: string; message: string; question: string | null },
  ): Handoff | Response {
    const sent = store.handoffs.followUp(botId, handoffId, from, delivery);
    if (!sent) return apiError(404, "not_found", `No handoff ${handoffId}`);
    if ("refused" in sent) return apiError(409, sent.refused, sent.message);
    if (sent.queued) {
      projects.ledgerChanged(sent.handoff.projectId);
      projects.queued(sent.handoff.projectId, owner.id, sent.queued);
    }
    return sent.handoff;
  }

  // One chief tool call of the bot, whose owner is `owner`.
  async function runTool(botId: BotId, owner: User, call: ChiefToolCall): Promise<Response> {
    switch (call.tool) {
      case "list_projects":
        return Response.json(
          store.workspaces.workspacesFor(owner.id).flatMap(({ id }) => store.projects.projectsIn(id)) satisfies Project[],
        );
      case "send_to_project": {
        const found = store.projects.projectFor(owner.id, call.project);
        if (!found) return apiError(404, "not_found", `No project ${call.project} in your owner's workspaces`);
        const { handoff, queued } = store.handoffs.create(botId, { userId: owner.id, login: owner.login }, found.project.id, call);
        projects.ledgerChanged(handoff.projectId);
        projects.queued(handoff.projectId, owner.id, queued);
        return Response.json(handoff satisfies Handoff);
      }
      case "message_project": {
        const { deliveryId, message, question = null } = call;
        const sent = followUp(botId, owner, call.handoff, "chief", { deliveryId, message, question });
        return sent instanceof Response ? sent : Response.json(sent satisfies Handoff);
      }
      case "handoff_status": {
        const projectIds = new Set(store.handoffs.of(botId, call.handoff).map(({ projectId }) => projectId));
        for (const projectId of projectIds) await workers.refreshVerdicts(projectId, owner.id);
        const handoffs = store.handoffs.of(botId, call.handoff);
        if (!call.handoff) return Response.json(handoffs satisfies Handoff[]);
        const [handoff] = handoffs;
        return handoff ? Response.json(handoff satisfies Handoff) : apiError(404, "not_found", `No handoff ${call.handoff}`);
      }
    }
  }

  const routes = {
    "/bots/:id/handoffs/:handoffId/messages": {
      POST: async (req: Bun.BunRequest<"/bots/:id/handoffs/:handoffId/messages">) => {
        const user = store.userForSession(bearer(req));
        if (!user) return unauthorized();
        const bot = store.botFor(user.id, req.params.id);
        const handoffId = HandoffId.safeParse(req.params.handoffId);
        if (!bot || !handoffId.success) return apiError(404, "not_found");
        const body = ReplyToHandoffRequest.safeParse(await req.json().catch(() => null));
        if (!body.success) return apiError(400, "invalid_message");
        const { text, question, deliveryId } = body.data;
        const sent = followUp(bot.id, user, handoffId.data, "owner", { deliveryId, message: text, question });
        return sent instanceof Response ? sent : new Response(null, { status: 204 });
      },
    },
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
