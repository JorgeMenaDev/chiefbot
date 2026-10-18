import { ApprovalId, type TurnId } from "@chiefbot/contracts";

// How an approval control asked for ended.
//   no_turn  nothing was asked: no turn is running, so nobody is there to answer
//   ended    the turn ended (its worker restarted) or the asker went away first
export type ApprovalOutcome = "approved" | "declined" | "no_turn" | "ended";

// Approvals control asks for itself, for the pushes and pull requests it holds
// (repos.ts). Each becomes an approval card in the running turn of the bot (or
// task worker) that asked, recorded like the worker's own, and waits however
// long the user takes.
// Every place a turn ends calls turnEnded, so this is also where what lives only
// as long as a turn (a connector's event stream) learns that it ended.
export function controlApprovals() {
  const waiting = new Map<ApprovalId, { turnId: TurnId; settle: (outcome: ApprovalOutcome) => void }>();
  const endings = new Map<TurnId, AbortController>();

  return {
    // Asks in a running turn and resolves with the outcome. `request` records the
    // approval-request under the id it is given and publishes it, answering the
    // turn it is in; null, recording nothing, when no turn runs. `signal`
    // aborting (the git client hung up) ends the wait.
    ask(request: (approvalId: ApprovalId) => { turnId: TurnId } | null, signal: AbortSignal): Promise<ApprovalOutcome> {
      const approvalId = ApprovalId.parse(`approval_${crypto.randomUUID()}`);
      const event = request(approvalId);
      if (!event) return Promise.resolve("no_turn");
      return new Promise<ApprovalOutcome>((resolve) => {
        const settle = (outcome: ApprovalOutcome) => {
          waiting.delete(approvalId);
          resolve(outcome);
        };
        waiting.set(approvalId, { turnId: event.turnId, settle });
        signal.addEventListener("abort", () => settle("ended"), { once: true });
      });
    },

    // The user answered (control stored it); wakes the request if control asked it.
    answered(approvalId: ApprovalId, approved: boolean) {
      waiting.get(approvalId)?.settle(approved ? "approved" : "declined");
    },

    // A turn ended: what it still waited on can no longer be answered, and its signal aborts.
    turnEnded(turnId: TurnId) {
      for (const { turnId: waitingOn, settle } of [...waiting.values()]) if (waitingOn === turnId) settle("ended");
      endings.get(turnId)?.abort();
      endings.delete(turnId);
    },

    // Aborts when the running turn ends. Ask for it in the same tick as the
    // check that the turn runs, so the end cannot come in between.
    turnSignal(turnId: TurnId): AbortSignal {
      const ending = endings.get(turnId) ?? new AbortController();
      endings.set(turnId, ending);
      return ending.signal;
    },
  };
}
