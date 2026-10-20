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
    tool(
      "update_task",
      "Change a task's title, detail, status or owner, or add links (a pull request, a context file, a page). " +
        "Setting status needs_input, put the one thing you need answered in question: whoever asked sees it.",
      UpdateTaskArgs,
    ),
    tool("list_tasks", "List the project's tasks, everyone's, newest last.", ListTasksArgs),
    tool("read_context", "Read one of the project's shared context files, or list them all.", ReadContextArgs),
    tool("write_context", "Write one of the project's shared context files (Markdown), replacing its content.", WriteContextArgs),
    tool(
      "dispatch_worker",
      "Start an engineer on a task: a fresh computer that clones the repo, runs its setup and does the task, ending in a draft pull request or a report. It returns at once with the engineer, queued when the project already runs its most; check on it with worker_status.",
      DispatchWorkerArgs,
      // The tool call's own id: control starts one worker per call, however often it arrives.
      ({ sessionId, toolCallId }) => ({ creationId: `${sessionId}/${toolCallId}` }),
    ),
    tool(
      "worker_status",
      "One engineer's state (queued, launching, setting_up, working, finished, blocked, failed or stopped) with its setup steps, result and pull request, or every engineer of the project.",
      WorkerStatusArgs,
    ),
    tool("worker_transcript", "What an engineer did: its setup steps, messages, tool calls, approvals and errors, oldest first.", WorkerTranscriptArgs),
    tool("stop_worker", "Stop an engineer and remove its computer.", StopWorkerArgs),
  ];
}
