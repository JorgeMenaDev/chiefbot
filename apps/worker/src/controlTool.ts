import type { Tool, ToolInvocation } from "@github/copilot-sdk";
import type { z } from "zod";

// The tool maker of an agent whose tool calls control answers (chiefTools.ts,
// coordinatorTools.ts). A tool's call is its arguments as the model gives them,
// plus what `extra` adds from the call itself, parsed as one of `Calls` and
// sent with `call`, which resolves with control's JSON answer. A refusal it
// throws is a failed call, as the model sees it.
export function controlTool<Calls extends z.ZodType<{ tool: string }>>(Calls: Calls, call: (toolCall: z.output<Calls>) => Promise<string>) {
  return <Args extends z.ZodObject>(
    name: z.output<Calls>["tool"],
    description: string,
    parameters: Args,
    extra: (invocation: ToolInvocation) => object = () => ({}),
  ) =>
    ({
      name,
      description,
      parameters,
      handler: (args: unknown, invocation: ToolInvocation) => call(Calls.parse({ tool: name, ...parameters.parse(args), ...extra(invocation) })),
    }) satisfies Tool<unknown>;
}
