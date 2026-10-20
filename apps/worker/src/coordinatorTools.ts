import {
  CoordinatorToolCall,
  CreateTaskArgs,
  DispatchVerifierArgs,
  DispatchWorkerArgs,
  ListTasksArgs,
  ReadContextArgs,
  StopWorkerArgs,
  UpdateTaskArgs,
  WorkerStatusArgs,
  WorkerTranscriptArgs,
  WriteContextArgs,
} from "@chiefbot/contracts";
import { controlTool } from "./controlTool.ts";

// The coordinator's tools that control keeps: the project's task ledger, shared
// context and workers (coordinator.ts adds its read-only repo tools, repoCopy.ts).
// `call` sends one call to control and resolves with its JSON answer; it throws
// control's refusal, which the model sees as a failed call.
export function coordinatorTools(call: (toolCall: CoordinatorToolCall) => Promise<string>) {
  const tool = controlTool(CoordinatorToolCall, call);

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
      "dispatch_verifier",
      "Start a verifier on a task's pull request (its latest, unless you name one it links): a fresh computer, never an engineer's, that checks the pull request at its head now, as a person would, and pushes nothing. It ends with a verdict on the task (pass, issues or blocked), its report and screenshots in the context's verify/ folder. It returns at once with the verifier; check on it with worker_status.",
      DispatchVerifierArgs,
      ({ sessionId, toolCallId }) => ({ creationId: `${sessionId}/${toolCallId}` }),
    ),
    tool(
      "worker_status",
      "One worker's state, an engineer's or a verifier's (queued, launching, setting_up, working, finished, blocked, failed or stopped), with its setup steps, result, pull request and verdict, or every worker of the project.",
      WorkerStatusArgs,
    ),
    tool("worker_transcript", "What a worker did: its setup steps, messages, tool calls, approvals and errors, oldest first.", WorkerTranscriptArgs),
    tool("stop_worker", "Stop a worker and remove its computer.", StopWorkerArgs),
  ];
}
