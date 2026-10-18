import type { Tool } from "@github/copilot-sdk";
import { ApiError, ChiefToolCall, HandoffStatusArgs, ListProjectsArgs, SendToProjectArgs } from "@chiefbot/contracts";
import type { z } from "zod";

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

  const tool = <Args extends z.ZodObject>(name: ChiefToolCall["tool"], description: string, parameters: Args) =>
    ({
      name,
      description,
      parameters,
      handler: (args: unknown) => call(ChiefToolCall.parse({ tool: name, ...parameters.parse(args) })),
    }) satisfies Tool<unknown>;

  return [
    tool("list_projects", "List the team projects you can hand work to: those of every workspace your owner belongs to.", ListProjectsArgs),
    tool(
      "send_to_project",
      "Hand a piece of work to a team project. Its coordinator gets it as a task and plans it with the team; you do not manage its workers. " +
        "You will be told in this chat when the project needs your owner's input and when it is done.",
      SendToProjectArgs,
    ),
    tool("handoff_status", "Where the work you handed to projects stands: each handoff's task status and links (pull requests, pages).", HandoffStatusArgs),
  ];
}
