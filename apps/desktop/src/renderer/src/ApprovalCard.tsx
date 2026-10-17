import type { ChatItem } from "@chiefbot/contracts";
import { useState } from "react";

export type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;

const approvalLabel: Record<ApprovalItem["request"], string> = {
  push: "Push approval",
  command: "Command approval",
  "pull-request": "Pull request approval",
  tool: "GitHub tool approval",
};

const approvalOutcome: Record<Exclude<ApprovalItem["state"], "pending">, string> = {
  approved: "Approved",
  declined: "Declined",
  expired: "Expired: the bot restarted before you answered",
};

// What the bot waits on, after T3 Code's ComposerPendingApprovalPanel and
// ComposerPendingApprovalActions: a label, the exact command or pull request,
// and Decline / Approve. It stays answerable until the bot's (or task worker's)
// turn ends, also after the app restarts. Answered, it shrinks to one line.
// `onAnswer` sends the answer to control.
export function ApprovalCard({ item, onAnswer }: { item: ApprovalItem; onAnswer: (approved: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(approved: boolean) {
    setBusy(true);
    setError(null);
    try {
      await onAnswer(approved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (item.state !== "pending") {
    return (
      <div className={`approval-row ${item.state}`}>
        {approvalLabel[item.request]}: {approvalOutcome[item.state]} <code>{item.detail.split("\n")[0]}</code>
      </div>
    );
  }
  return (
    <div className="approval-card" role="group" aria-label={approvalLabel[item.request]}>
      <span className="approval-label">{approvalLabel[item.request]}</span>
      <code className="approval-detail">{item.detail}</code>
      <div className="approval-actions">
        {error && <span className="error">{error}</span>}
        <button className="outline" disabled={busy} onClick={() => void answer(false)}>
          Decline
        </button>
        <button disabled={busy} onClick={() => void answer(true)}>
          Approve
        </button>
      </div>
    </div>
  );
}
