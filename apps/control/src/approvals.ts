import { ApprovalId, type ApprovalKind, type BotId, type ChatEvent, type TurnId } from "@chiefbot/contracts";
import type { openStore } from "./store.ts";

// How an approval control asked for ended.
//   no_turn  nothing was asked: no turn is running, so nobody is there to answer
//   ended    the turn ended (its worker restarted) or the asker went away first
export type ApprovalOutcome = "approved" | "declined" | "no_turn" | "ended";

// Approvals control asks for itself, for the pushes and pull requests it holds
// (repos.ts). Each becomes an approval card in the bot's running turn, recorded
// like the worker's own, and waits however long the user takes.
export function controlApprovals({
  store,
  publishChat,
}: {
  store: ReturnType<typeof openStore>;
  // Stores nothing: publishes a stored chat event to the bot's chat (turns.ts).
  publishChat: (botId: BotId, event: ChatEvent) => void;
}) {
  const waiting = new Map<ApprovalId, { turnId: TurnId; settle: (outcome: ApprovalOutcome) => void }>();

  return {
    // Asks the bot's owner in its running turn and resolves with the outcome.
    // `signal` aborting (the git client hung up) ends the wait.
    ask(botId: BotId, kind: ApprovalKind, detail: string, signal: AbortSignal): Promise<ApprovalOutcome> {
      const approvalId = ApprovalId.parse(`approval_${crypto.randomUUID()}`);
      const event = store.requestApproval(botId, { approvalId, kind, detail });
      if (!event) return Promise.resolve("no_turn");
      const outcome = new Promise<ApprovalOutcome>((resolve) => {
        const settle = (outcome: ApprovalOutcome) => {
          waiting.delete(approvalId);
          resolve(outcome);
        };
        waiting.set(approvalId, { turnId: event.turnId, settle });
        signal.addEventListener("abort", () => settle("ended"), { once: true });
      });
      publishChat(botId, event);
      return outcome;
    },

    // The user answered (control stored it); wakes the request if control asked it.
    answered(approvalId: ApprovalId, approved: boolean) {
      waiting.get(approvalId)?.settle(approved ? "approved" : "declined");
    },

    // A turn ended: what it still waited on can no longer be answered.
    turnEnded(turnId: TurnId) {
      for (const { turnId: waitingOn, settle } of [...waiting.values()]) if (waitingOn === turnId) settle("ended");
    },
  };
}
