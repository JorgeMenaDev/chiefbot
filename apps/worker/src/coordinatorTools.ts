import type { Tool } from "@github/copilot-sdk";
import {
  CoordinatorToolCall,
  CreateTaskArgs,
  ListTasksArgs,
  ReadContextArgs,
  UpdateTaskArgs,
  WriteContextArgs,
} from "@chiefbot/contracts";
import type { z } from "zod";

// The coordinator's only tools: the project's task ledger and shared context,
// both kept by control. `call` sends one call to control and resolves with its
// JSON answer; it throws control's refusal, which the model sees as a failed call.
export function coordinatorTools(call: (toolCall: CoordinatorToolCall) => Promise<string>) {
  const tool = <Args extends z.ZodObject>(name: CoordinatorToolCall["tool"], description: string, parameters: Args) =>
    ({
      name,
      description,
      parameters,
      handler: (args: unknown) => call(CoordinatorToolCall.parse({ tool: name, ...parameters.parse(args) })),
    }) satisfies Tool<unknown>;

  return [
    tool(
      "create_task",
      "Add a task to the project's ledger. Call list_tasks first: when a task already covers the request, update that one instead.",
      CreateTaskArgs,
    ),
    tool("update_task", "Change a task's title, detail, status or owner, or add links (a pull request, a context file, a page).", UpdateTaskArgs),
    tool("list_tasks", "List the project's tasks, everyone's, newest last.", ListTasksArgs),
    tool("read_context", "Read one of the project's shared context files, or list them all.", ReadContextArgs),
    tool("write_context", "Write one of the project's shared context files (Markdown), replacing its content.", WriteContextArgs),
  ];
}
