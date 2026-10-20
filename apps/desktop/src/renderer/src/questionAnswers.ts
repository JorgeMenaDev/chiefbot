// A question card's draft and the answer it makes, adapted from T3 Code's
// apps/web/src/pendingUserInput.ts (MIT). Unlike T3's, a pick may carry a comment.
import type { Question, QuestionForm, QuestionResult } from "@chiefbot/contracts";
import { z } from "zod";

// What the user has for one question so far: the options picked, the answer
// typed (a text question's answer, or a choice's "Other") and a comment.
const AnswerDraft = z.object({ picks: z.array(z.string()), text: z.string(), comment: z.string() });
export type AnswerDraft = z.infer<typeof AnswerDraft>;
// The whole card's: the step it shows, and each question's draft by its key.
const QuestionDraft = z.object({ step: z.number().int().min(0), answers: z.record(z.string(), AnswerDraft) });
export type QuestionDraft = z.infer<typeof QuestionDraft>;

export const emptyAnswer: AnswerDraft = { picks: [], text: "", comment: "" };
const emptyDraft: QuestionDraft = { step: 0, answers: {} };

// A saved draft (JSON), or a fresh one when there is none or it no longer parses.
export function draftOf(saved: string | null): QuestionDraft {
  try {
    return QuestionDraft.safeParse(JSON.parse(saved ?? "null")).data ?? emptyDraft;
  } catch {
    return emptyDraft;
  }
}

// Picks `value`: a single question's only pick, or one more (or one fewer) of a
// multi question's. A pick clears the typed answer it would replace.
export function togglePick(question: Question, draft: AnswerDraft, value: string): AnswerDraft {
  const picks = question.kind !== "multi" ? [value] : draft.picks.includes(value) ? draft.picks.filter((pick) => pick !== value) : [...draft.picks, value];
  return { ...draft, picks, text: "" };
}

// Types an answer. For a choice it is "Other", which replaces the picks.
export function typeAnswer(draft: AnswerDraft, text: string): AnswerDraft {
  return { ...draft, text, picks: text.trim() === "" ? draft.picks : [] };
}

// One question's answer as the agent gets it, or null while it has none. The
// typed answer replaces the picks. A comment keeps them: a single pick becomes
// "<pick> — <comment>", and a multi question gets it as one more value.
export function answerOf(question: Question, draft: AnswerDraft = emptyAnswer): string | string[] | null {
  const text = draft.text.trim();
  if (question.kind === "text") return text || null;
  const picks = text ? [text] : question.options.flatMap(({ value }) => (draft.picks.includes(value) ? [value] : []));
  const [first] = picks;
  if (first === undefined) return null;
  const comment = draft.comment.trim();
  if (question.kind === "multi") return comment ? [...picks, comment] : picks;
  return comment ? `${first} — ${comment}` : first;
}

// The answer to the whole form, or null while a question has none.
export function formResult(form: QuestionForm, draft: QuestionDraft): QuestionResult | null {
  const content: Record<string, string | string[]> = {};
  for (const question of form.questions) {
    const answer = answerOf(question, draft.answers[question.key]);
    if (answer === null) return null;
    content[question.key] = answer;
  }
  return { action: "accept", content };
}

// An answer as an answered card shows it: each picked option by its label.
export function answerText(question: Question, answer: string | string[] | undefined): string {
  const values = answer === undefined ? [] : typeof answer === "string" ? [answer] : answer;
  const label = (value: string) => {
    for (const option of question.options) {
      if (value === option.value) return option.label;
      if (value.startsWith(`${option.value} — `)) return option.label + value.slice(option.value.length);
    }
    return value;
  };
  return values.map(label).join(", ");
}
