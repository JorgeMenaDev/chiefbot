import { ApiError, ChiefToolCall, HandoffStatusArgs, ListProjectsArgs, MessageProjectArgs, SendToProjectArgs } from "@chiefbot/contracts";
import { controlTool } from "./controlTool.ts";

// A bot's tools as its owner's chief of staff: it hands work to a project of
// one of its owner's workspaces and follows it. Control keeps the handoffs and
// answers each call as JSON; a refusal throws, which the model sees as a failed call.
// Each call carries the key of the turn its session was opened for, from `turnKey`.
export function chiefTools({ controlUrl, botId, turnKey }: { controlUrl: string; botId: string; turnKey: () => string }) {
  async function call(toolCall: ChiefToolCall) {
    const res = await fetch(`${controlUrl}/worker/${botId}/chief-tools`, {
      method: "POST",
      headers: { authorization: `Bearer ${turnKey()}`, "content-type": "application/json" },
      body: JSON.stringify(toolCall),
    });
    if (res.ok) return res.text();
    const refusal = ApiError.safeParse(await res.json().catch(() => null));
    throw new Error(refusal.success ? (refusal.data.message ?? refusal.data.error) : `Control answered ${res.status}`);
  }

  const tool = controlTool(ChiefToolCall, call);

  return [
    tool("list_projects", "List the team projects you can hand work to: those of every workspace your owner belongs to.", ListProjectsArgs),
    tool(
      "send_to_project",
      "Hand a new piece of work to a team project. Its coordinator gets it as a task and plans it with the team; you do not manage its workers. " +
        "Your owner sees a card in this chat that follows it. For more about work you already handed over, use message_project instead.",
      SendToProjectArgs,
    ),
    tool(
      "message_project",
      "Send a follow-up about work you already handed to a project, or your owner's answer to its question. " +
        "It reaches the same task and the same chat with the project's coordinator, never a new task. " +
        "While the project asks a question (handoff_status shows it), name that question in `question`: a message naming " +
        "another question, or none, is refused with what the project asks now, so check that with your owner first. " +
        "Once the task is done or abandoned it is refused: hand over new work with send_to_project.",
      MessageProjectArgs,
      // The tool call's own id: control delivers one message per call, however often it arrives.
      ({ sessionId, toolCallId }) => ({ deliveryId: `${sessionId}/${toolCallId}` }),
    ),
    tool(
      "handoff_status",
      "Where the work you handed to projects stands: each handoff's task status, the project's open question, its workers, " +
        "links (pull requests, pages) and the coordinator's last reply about it.",
      HandoffStatusArgs,
    ),
  ];
}
