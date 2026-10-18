import type { Tool, ToolInvocation } from "@github/copilot-sdk";
import {
  CoordinatorToolCall,
  CreateTaskArgs,
  DispatchWorkerArgs,
  ListTasksArgs,
  ReadContextArgs,
  StopWorkerArgs,
  UpdateTaskArgs,
  WorkerStatusArgs,
  WorkerTranscriptArgs,
  WriteContextArgs,
} from "@chiefbot/contracts";
import type { z } from "zod";

// The coordinator's only tools: the project's task ledger, shared context and
// workers, all kept by control. `call` sends one call to control and resolves
// with its JSON answer; it throws control's refusal, which the model sees as a
// failed call. `extra` adds fields the model does not give, from the call itself.
export function coordinatorTools(call: (toolCall: CoordinatorToolCall) => Promise<string>) {
  const tool = <Args extends z.ZodObject>(
    name: CoordinatorToolCall["tool"],
    description: string,
    parameters: Args,
    extra: (invocation: ToolInvocation) => object = () => ({}),
  ) =>
    ({
      name,
      description,
      parameters,
      handler: (args: unknown, invocation: ToolInvocation) =>
        call(CoordinatorToolCall.parse({ tool: name, ...parameters.parse(args), ...extra(invocation) })),
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
    tool(
      "dispatch_worker",
      "Start a worker on a task: a fresh computer that clones the repo, does the task and opens a pull request. It returns at once with the worker; check on it with worker_status.",
      DispatchWorkerArgs,
      // The tool call's own id: control starts one worker per call, however often it arrives.
      ({ sessionId, toolCallId }) => ({ creationId: `${sessionId}/${toolCallId}` }),
    ),
    tool(
      "worker_status",
      "One worker's state (launching, working, finished, failed or stopped) with its result and pull request, or every worker of the project.",
      WorkerStatusArgs,
    ),
    tool("worker_transcript", "What a worker did: its messages, tool calls, approvals and errors, oldest first.", WorkerTranscriptArgs),
    tool("stop_worker", "Stop a worker and remove its computer.", StopWorkerArgs),
  ];
}
