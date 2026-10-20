import type { ChatItem } from "@chiefbot/contracts";
import { CheckIcon, XIcon } from "lucide-react";
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

const outcomeColor: Record<Exclude<ApprovalItem["state"], "pending">, string> = {
  approved: "text-success-foreground",
  declined: "text-destructive-foreground",
  expired: "text-muted-foreground",
  withdrawn: "text-muted-foreground",
};

// What the bot waits on, after T3 Code's ComposerPendingApprovalPanel and
// ComposerPendingApprovalActions: a label, the exact command or pull request,
// and Decline / Approve. It stays answerable until the bot's (or task worker's)
// turn ends, also after the app restarts. Answered, the outcome takes the
// buttons' place in a line of the same height, so the card keeps its size and
// nothing under it moves. `onAnswer` sends the answer to control.
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

  const pending = item.state === "pending";
  return (
    <div
      role="group"
      aria-label={approvalLabel[item.request]}
      className={cn("rounded-xl border px-4 py-3 transition-colors", pending ? "border-warning/40 bg-warning/4" : "bg-card/40")}
    >
      <div className="flex min-w-0 items-center gap-2">
        {pending && <span className="shrink-0 text-[11px] text-warning-foreground uppercase tracking-[0.2em]">Pending approval</span>}
        <span className="truncate font-medium text-sm">{approvalLabel[item.request]}</span>
      </div>
      <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/65 bg-background/70 p-3 font-mono text-xs leading-relaxed">
        {item.detail}
      </pre>
      <div className="mt-3 flex h-7 items-center justify-end gap-2">
        {item.state === "pending" ? (
          <>
            {error && <span className="me-auto truncate text-destructive-foreground text-xs">{error}</span>}
            <Button size="sm" variant="destructive-outline" disabled={busy} onClick={() => void answer(false)}>
              Decline
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
              Approve
            </Button>
          </>
        ) : (
          <span className={cn("flex min-w-0 items-center gap-1.5 text-xs", outcomeColor[item.state])}>
            {item.state === "approved" ? <CheckIcon className="size-3.5 shrink-0" /> : <XIcon className="size-3.5 shrink-0" />}
            <span className="truncate">{approvalOutcome[item.state]}</span>
          </span>
        )}
      </div>
    </div>
  );
}
