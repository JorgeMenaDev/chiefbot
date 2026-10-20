import type { ChatItem } from "@chiefbot/contracts";
import { useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";

export type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;

const approvalLabel: Record<ApprovalItem["request"], string> = {
  push: "Push approval",
  command: "Command approval",
  "pull-request": "Pull request approval",
  tool: "GitHub tool approval",
  connector: "Connector approval",
  "file-change": "File change approval",
};

const approvalOutcome: Record<Exclude<ApprovalItem["state"], "pending">, string> = {
  approved: "Approved",
  declined: "Declined",
  expired: "Expired: the bot restarted before you answered",
  withdrawn: "Withdrawn: the agent stopped waiting, and asks again if it still needs this",
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
      <div className={cn("flex min-w-0 items-center gap-1.5 text-xs", item.state === "approved" ? "text-success-foreground" : "text-destructive-foreground")}>
        <span className="shrink-0">
          {approvalLabel[item.request]}: {approvalOutcome[item.state]}
        </span>
        <code className="truncate font-mono text-muted-foreground">{item.detail.split("\n")[0]}</code>
      </div>
    );
  }
  return (
    <div role="group" aria-label={approvalLabel[item.request]} className="rounded-xl border border-warning/40 bg-warning/4 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-warning-foreground uppercase tracking-[0.2em]">Pending approval</span>
        <span className="font-medium text-sm">{approvalLabel[item.request]}</span>
      </div>
      <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/65 bg-background/70 p-3 font-mono text-xs leading-relaxed">
        {item.detail}
      </pre>
      <div className="mt-3 flex items-center justify-end gap-2">
        {error && <span className="me-auto text-destructive-foreground text-xs">{error}</span>}
        <Button size="sm" variant="destructive-outline" disabled={busy} onClick={() => void answer(false)}>
          Decline
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
          Approve
        </Button>
      </div>
    </div>
  );
}
