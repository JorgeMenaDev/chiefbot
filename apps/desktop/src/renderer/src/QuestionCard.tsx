import type { ChatItem, Question, QuestionResult } from "@chiefbot/contracts";
import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "./components/ui/button.tsx";
import { Textarea } from "./components/ui/input.tsx";
import { cn } from "./lib/utils.ts";
import { answerOf, answerText, draftOf, emptyAnswer, formResult, togglePick, typeAnswer, type AnswerDraft, type QuestionDraft } from "./questionAnswers.ts";

export type QuestionItem = Extract<ChatItem, { kind: "question" }>;

// Where a pending card keeps its draft, so a reload of the window keeps it too.
const draftKey = (item: QuestionItem) => `chiefbot.question.${item.questionId}`;

// What the bot asks its user, after T3 Code's ComposerPendingUserInputPanel:
// one question at a time with a step counter, numbered options (keys 1–9 pick
// one while no text field has focus), "Other" to type an answer of your own and
// a comment that keeps the pick. Enter moves on, or sends on the last step,
// which has its own Submit answers button: no pick sends anything by itself.
// Don't answer declines; Esc does nothing. Answered, it shows the answers; a
// withdrawn or expired question is muted. `onAnswer` sends to control.
export function QuestionCard({ item, onAnswer }: { item: QuestionItem; onAnswer: (result: QuestionResult) => Promise<void> }) {
  return item.state === "pending" ? <PendingQuestion item={item} onAnswer={onAnswer} /> : <SettledQuestion item={item} state={item.state} />;
}

function PendingQuestion({ item, onAnswer }: { item: QuestionItem; onAnswer: (result: QuestionResult) => Promise<void> }) {
  const { form } = item;
  const key = draftKey(item);
  const [draft, setDraft] = useState<QuestionDraft>(() => draftOf(readSaved(key)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const fieldset = useRef<HTMLFieldSetElement>(null);
  // Set when the user moves to another step, so focus follows to it (never on mount).
  const moved = useRef(false);
  const total = form.questions.length;
  const step = Math.min(draft.step, total - 1);
  const question = form.questions[step] ?? form.questions[0];
  const answer = draft.answers[question.key] ?? emptyAnswer;
  const answered = answerOf(question, answer) !== null;
  const last = step === total - 1;
  const result = formResult(form, draft);

  useEffect(() => saveDraft(key, draft), [key, draft]);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    fieldset.current?.querySelector<HTMLElement>("input:checked, input, textarea")?.focus();
  }, [step]);

  const change = (next: (answer: AnswerDraft) => AnswerDraft) =>
    setDraft((current) => ({ ...current, answers: { ...current.answers, [question.key]: next(current.answers[question.key] ?? emptyAnswer) } }));
  const goTo = (next: number) => {
    moved.current = true;
    setDraft((current) => ({ ...current, step: next }));
  };

  async function send(answer: QuestionResult) {
    setBusy(true);
    setError(null);
    try {
      await onAnswer(answer);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  // Next, or Submit answers on the last step, once this question has an answer.
  const advance = () => {
    if (busy || !answered) return;
    if (!last) goTo(step + 1);
    else if (result) void send(result);
  };

  // Keys 1–9 pick an option while focus is not in a text field (T3 Code's shortcut).
  useEffect(() => {
    if (question.kind === "text" || busy) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || !/^[1-9]$/.test(event.key)) return;
      const option = question.options[Number(event.key) - 1];
      if (!option) return;
      event.preventDefault();
      setDraft((current) => ({
        ...current,
        answers: { ...current.answers, [question.key]: togglePick(question, current.answers[question.key] ?? emptyAnswer, option.value) },
      }));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [question, busy]);

  // Enter moves on; Shift+Enter is a new line in a text box, and a button's Enter presses it.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    advance();
  };

  const status = busy ? "Sending your answers…" : `Question ${step + 1} of ${total}: ${question.title}`;
  return (
    <div role="group" aria-labelledby={`${id}-message`} className="rounded-xl border border-info/40 bg-info/4 px-4 py-3" onKeyDown={onKeyDown}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px] text-info-foreground uppercase tracking-[0.2em]">Question</span>
        {total > 1 && (
          <span className="ms-auto shrink-0 text-muted-foreground text-xs tabular-nums">
            {step + 1} of {total}
          </span>
        )}
      </div>
      <p id={`${id}-message`} className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">
        {form.message}
      </p>
      <fieldset ref={fieldset} key={question.key} disabled={busy} aria-describedby={question.description ? `${id}-help` : undefined} className="mt-3 min-w-0">
        <legend className="font-medium text-sm">{question.title}</legend>
        {question.description && (
          <p id={`${id}-help`} className="mt-0.5 text-muted-foreground text-xs">
            {question.description}
          </p>
        )}
        {question.kind === "text" ? (
          <Textarea
            rows={1}
            aria-label={question.title}
            className="mt-2 min-h-9 resize-none"
            placeholder="Type your answer"
            value={answer.text}
            onChange={(event) => change((draft) => typeAnswer(draft, event.target.value))}
          />
        ) : (
          <Choices question={question} answer={answer} name={`${id}-${question.key}`} onPick={(value) => change((draft) => togglePick(question, draft, value))} onChange={change} />
        )}
      </fieldset>
      <div className="mt-3 flex min-h-7 items-center gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send({ action: "decline" })}>
          Don't answer
        </Button>
        {error && (
          <span role="alert" className="min-w-0 flex-1 truncate text-destructive-foreground text-xs" title={error}>
            {error}
          </span>
        )}
        <div className="ms-auto flex shrink-0 gap-2">
          {step > 0 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => goTo(step - 1)}>
              Back
            </Button>
          )}
          {last ? (
            <Button size="sm" disabled={busy || !result} onClick={() => result && void send(result)}>
              Submit answers
            </Button>
          ) : (
            <Button size="sm" disabled={!answered} onClick={() => goTo(step + 1)}>
              Next
            </Button>
          )}
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {status}
      </p>
    </div>
  );
}

// A choice question's options as radios (single) or checkboxes (multi), each
// numbered for its key, then "Other" and an optional comment.
function Choices({
  question,
  answer,
  name,
  onPick,
  onChange,
}: {
  question: Question;
  answer: AnswerDraft;
  name: string;
  onPick: (value: string) => void;
  onChange: (next: (answer: AnswerDraft) => AnswerDraft) => void;
}) {
  const multi = question.kind === "multi";
  return (
    <>
      {multi && <p className="mt-0.5 text-muted-foreground text-xs">Pick one or more.</p>}
      <div className="mt-2 flex flex-col gap-0.5">
        {question.options.map((option, index) => {
          const picked = answer.picks.includes(option.value);
          return (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                picked ? "bg-info/10 text-foreground" : "text-foreground/85 hover:bg-muted/40",
              )}
            >
              <input type={multi ? "checkbox" : "radio"} name={name} value={option.value} checked={picked} onChange={() => onPick(option.value)} className="sr-only" />
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center border transition-colors",
                  multi ? "rounded-[4px]" : "rounded-full",
                  picked ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background dark:bg-input/32",
                )}
              >
                {picked && (multi ? <CheckIcon className="size-3" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-primary-foreground" />)}
              </span>
              <span className="min-w-0 flex-1">{option.label}</span>
              {index < 9 && (
                <kbd className="flex size-5 shrink-0 items-center justify-center rounded border border-border/70 font-medium font-sans text-[11px] text-muted-foreground tabular-nums">
                  {index + 1}
                </kbd>
              )}
            </label>
          );
        })}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-muted-foreground text-xs">
          Other
          <Textarea
            rows={1}
            className="min-h-8 resize-none"
            placeholder="Type your own answer"
            value={answer.text}
            onChange={(event) => onChange((draft) => typeAnswer(draft, event.target.value))}
          />
        </label>
        <label className="grid gap-1 text-muted-foreground text-xs">
          Comment (optional)
          <Textarea
            rows={1}
            className="min-h-8 resize-none"
            placeholder="Add a note to your answer"
            value={answer.comment}
            onChange={(event) => onChange((draft) => ({ ...draft, comment: event.target.value }))}
          />
        </label>
      </div>
    </>
  );
}

const outcome = {
  answered: "Answered",
  declined: "You chose not to answer",
  expired: "Expired: the bot restarted before you answered",
  withdrawn: "Withdrawn: the bot stopped waiting for this answer",
} as const;

// An answered card shows each question with its answer; a declined, withdrawn
// or expired one is muted. Its saved draft goes.
function SettledQuestion({ item, state }: { item: QuestionItem; state: Exclude<QuestionItem["state"], "pending"> }) {
  const key = draftKey(item);
  useEffect(() => saveDraft(key, null), [key]);
  const content = item.answer?.action === "accept" ? item.answer.content : null;
  const shown = state === "answered" ? (content ? "answered" : "declined") : state;
  return (
    <div role="group" aria-label="Question" className={cn("rounded-xl border bg-card/40 px-4 py-3", !content && "text-muted-foreground")}>
      <span className="text-[11px] text-muted-foreground uppercase tracking-[0.2em]">Question</span>
      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">{item.form.message}</p>
      <dl className="mt-2 grid gap-2">
        {item.form.questions.map((question) => (
          <div key={question.key} className="min-w-0">
            <dt className="text-muted-foreground text-xs">{question.title}</dt>
            {content && <dd className="whitespace-pre-wrap break-words text-sm">{answerText(question, content[question.key])}</dd>}
          </div>
        ))}
      </dl>
      <p role="status" className={cn("mt-3 flex items-center gap-1.5 text-xs", content ? "text-success-foreground" : "text-muted-foreground")}>
        {content ? <CheckIcon className="size-3.5 shrink-0" /> : <XIcon className="size-3.5 shrink-0" />}
        {outcome[shown]}
      </p>
    </div>
  );
}

// Whether the user is typing where a digit is text, not an option's key, or in an open dialog.
const typing = (target: EventTarget | null) =>
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLInputElement && target.type !== "radio" && target.type !== "checkbox") ||
  (target instanceof HTMLElement && (target.isContentEditable || target.closest("dialog[open], [role=dialog]") !== null));

// The saved draft, or null when there is none or storage cannot be read.
function readSaved(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Saves the draft, or forgets it (null). A draft that cannot be saved lasts until reload.
function saveDraft(key: string, draft: QuestionDraft | null) {
  try {
    if (draft) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {}
}
