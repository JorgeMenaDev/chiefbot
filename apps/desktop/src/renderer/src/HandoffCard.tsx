import type { ChatItem, HandoffStage, ReplyToHandoffRequest } from "@chiefbot/contracts";
import { FolderGit2Icon, SendIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { Button } from "./components/ui/button.tsx";
import { Textarea } from "./components/ui/input.tsx";
import { cn } from "./lib/utils.ts";
import { verdictColor, verdictText } from "./ProjectTasks.tsx";

export type HandoffItem = Extract<ChatItem, { kind: "handoff" }>;

const stageLabel: Record<HandoffStage, string> = {
  accepted: "Accepted",
  working: "Working",
  needs_input: "Needs your input",
  pr_opened: "Pull request opened",
  verified: "Verified",
  done: "Done",
  abandoned: "Abandoned",
};

const stageColor: Record<HandoffStage, string> = {
  accepted: "text-muted-foreground",
  working: "text-info-foreground",
  needs_input: "text-warning-foreground",
  pr_opened: "text-info-foreground",
  verified: "text-success-foreground",
  done: "text-success-foreground",
  abandoned: "text-muted-foreground",
};

// "Pull request #7" for a GitHub pull request's URL, else the URL.
const pullRequestName = (url: string) => {
  const number = /\/pull\/(\d+)\/?$/.exec(url)?.[1];
  return number ? `Pull request #${number}` : url;
};

// The reply that sends `text` as the answer to `question`, when `unanswered` was
// sent and got no reply (control may have it): that same reply for the same
// answer to the same question, so control delivers it once; else one with a new
// delivery id, since control refuses another message under the old one.
export const replyFor = (unanswered: ReplyToHandoffRequest | null, text: string, question: string | null): ReplyToHandoffRequest =>
  unanswered?.text === text && unanswered.question === question ? unanswered : { text, question, deliveryId: crypto.randomUUID() };

// Work the chief of staff handed to a project, in the chief's chat: one card per
// handoff that control keeps up to date (ApprovalCard's look). It names the
// project's task and where it stands, with its pull requests and a verifier's
// verdict on the latest (stale once it moved). While the project
// needs input, it shows the question and a box to answer it: the answer goes to
// the same task in the project's chat (`onReply`). Each answer carries the
// question it was started for: when the project asks something else by the
// time it is sent, the card keeps it and shows the new question to check it
// against. Enter sends, Shift+Enter adds a line. `onOpen` opens the project.
export function HandoffCard({
  item,
  onReply,
  onOpen,
}: {
  item: HandoffItem;
  onReply: (reply: ReplyToHandoffRequest) => Promise<void>;
  onOpen: () => void;
}) {
  const [draft, setDraft] = useState("");
  // The question shown when the draft was started.
  const [answering, setAnswering] = useState(item.question);
  const [unanswered, setUnanswered] = useState<ReplyToHandoffRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const asking = item.stage === "needs_input";
  const canSend = asking && !busy && draft.trim() !== "";

  async function send() {
    if (!canSend) return;
    if (answering !== item.question) {
      setAnswering(item.question);
      setError("The question changed. Check your answer, then send it again.");
      return;
    }
    const reply = replyFor(unanswered, draft, answering);
    setUnanswered(reply);
    setBusy(true);
    setError(null);
    try {
      await onReply(reply);
      setDraft("");
      setUnanswered(null);
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  }

  return (
    <div
      role="group"
      aria-label={`Handoff to ${item.project}: ${item.title}`}
      className={cn("rounded-xl border px-4 py-3 transition-colors", asking ? "border-warning/40 bg-warning/4" : "bg-card/40")}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span aria-live="polite" className={cn("shrink-0 text-[11px] uppercase tracking-[0.2em]", stageColor[item.stage])}>
          {stageLabel[item.stage]}
        </span>
        <span className="truncate font-medium text-sm">{item.title}</span>
      </div>
      <p className="mt-1 truncate text-muted-foreground text-xs">
        Handed to {item.project} · task #{item.taskNumber}
      </p>
      {item.question && (
        <p className="mt-3 whitespace-pre-wrap break-words rounded-lg border border-border/65 bg-background/70 p-3 text-sm leading-relaxed">
          {item.question}
        </p>
      )}
      {item.pullRequests.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-x-3 text-xs">
          {item.pullRequests.map((url) => (
            <a key={url} className="text-primary underline-offset-4 hover:underline" href={url} target="_blank" rel="noreferrer">
              {pullRequestName(url)}
            </a>
          ))}
        </p>
      )}
      {item.verification && (
        <p className={cn("mt-1 text-xs", verdictColor(item.verification))}>
          {verdictText(item.verification)}
          {item.verification.result !== "pass" && `: ${item.verification.summary}`}
        </p>
      )}
      {asking && (
        <Textarea
          className="mt-3 resize-none"
          rows={2}
          aria-label={`Answer ${item.project}`}
          placeholder={`Answer ${item.project}`}
          value={draft}
          disabled={busy}
          onChange={(event) => {
            if (draft === "") setAnswering(item.question);
            setDraft(event.target.value);
            setSent(false);
          }}
          onKeyDown={onKeyDown}
        />
      )}
      <div className="mt-3 flex h-7 items-center justify-end gap-2">
        {error ? (
          <span className="me-auto truncate text-destructive-foreground text-xs">{error}</span>
        ) : (
          sent && <span className="me-auto truncate text-muted-foreground text-xs">Sent to {item.project}</span>
        )}
        <Button size="sm" variant="outline" onClick={onOpen}>
          <FolderGit2Icon />
          Open in Projects
        </Button>
        {asking && (
          <Button size="sm" disabled={!canSend} onClick={() => void send()}>
            <SendIcon />
            Send answer
          </Button>
        )}
      </div>
    </div>
  );
}
