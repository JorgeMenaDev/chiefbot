import type { SessionEvent } from "@github/copilot-sdk";
import type { TurnEvent } from "@chiefbot/contracts";
import { computerRow, computerToolName } from "./computerUse.ts";

// What one running turn has streamed so far: the messages that came in chunks
// and each tool call's name, so a completion can say which tool finished.
export type TurnStream = { deltaMessageIds: Set<string>; toolNames: Map<string, string> };

export const newTurnStream = (): TurnStream => ({ deltaMessageIds: new Set(), toolNames: new Map() });

// The TurnEvents one Copilot SDK session event of a main-agent turn becomes
// (sub-agent events are the caller's to drop). A turn ends with `done`, after
// `error` when the session failed.
export function toTurnEvents(event: SessionEvent, { deltaMessageIds, toolNames }: TurnStream): TurnEvent[] {
  switch (event.type) {
    case "assistant.intent":
      return [{ type: "status", text: event.data.intent }];
    case "assistant.message_delta":
      deltaMessageIds.add(event.data.messageId);
      return [{ type: "text-delta", messageId: event.data.messageId, text: event.data.deltaContent }];
    // The whole message. Sent as one chunk only when it did not stream.
    case "assistant.message":
      if (deltaMessageIds.has(event.data.messageId) || !event.data.content) return [];
      return [{ type: "text-delta", messageId: event.data.messageId, text: event.data.content }];
    // A computer call's row also names its actions.
    case "tool.execution_start": {
      const { toolName, toolTitle, arguments: args } = event.data;
      const name = toolName === computerToolName ? computerRow(args) : (toolTitle ?? toolName);
      toolNames.set(event.data.toolCallId, name);
      return [{ type: "tool-call", toolCallId: event.data.toolCallId, name, status: "running" }];
    }
    case "tool.execution_complete":
      return [
        {
          type: "tool-call",
          toolCallId: event.data.toolCallId,
          name: toolNames.get(event.data.toolCallId) ?? "tool",
          status: event.data.success ? "succeeded" : "failed",
        },
      ];
    case "session.error":
      return [{ type: "error", message: event.data.message }, { type: "done" }];
    case "session.idle":
      return [{ type: "done" }];
    default:
      return [];
  }
}
