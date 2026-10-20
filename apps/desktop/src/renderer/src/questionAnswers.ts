// A question card's draft and the answer it makes, adapted from T3 Code's
// apps/web/src/pendingUserInput.ts (MIT). Unlike T3's, a pick may carry a comment.
import type { Answer, Question, QuestionForm, QuestionResult } from "@chiefbot/contracts";
import { z } from "zod";

// What the user has for one question so far: the options picked, the answer
// typed (a text question's answer, or a choice's "Other") and a comment.
const AnswerDraft = z.object({ picks: z.array(z.string()), text: z.string(), comment: z.string() });
export type AnswerDraft = z.infer<typeof AnswerDraft>;
// The whole card's: the step it shows, and each question's draft in the form's
// order (by position, never by schema key, so any key is safe).
const QuestionDraft = z.object({ step: z.number().int().min(0), answers: z.array(AnswerDraft) });
export type QuestionDraft = z.infer<typeof QuestionDraft>;

export const emptyAnswer: AnswerDraft = { picks: [], text: "", comment: "" };

// A saved draft (JSON) for a form of `total` questions, or a fresh one when
// there is none or it no longer fits.
export function draftOf(saved: string | null, total: number): QuestionDraft {
  const fresh = { step: 0, answers: Array.from({ length: total }, () => emptyAnswer) };
  try {
    const draft = QuestionDraft.safeParse(JSON.parse(saved ?? "null")).data;
    return draft?.answers.length === total ? draft : fresh;
  } catch {
    return fresh;
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

// A single or text answer as the type its question's schema asks for, when it
// reads as one ("3" for a number, "false" for a yes/no); otherwise as written.
function typed(type: Question["type"], text: string): Answer {
  if (type === "boolean" && (text === "true" || text === "false")) return text === "true";
  if (type === "number" && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (type === "integer" && /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
  return text;
}

// One question's answer as the agent gets it, or null while it has none. The
// typed answer replaces the picks. A comment keeps them: a single pick becomes
// "<pick> — <comment>", and a multi question gets it as one more value.
export function answerOf(question: Question, draft: AnswerDraft = emptyAnswer): Answer | null {
  const text = draft.text.trim();
  if (question.kind === "text") return text ? typed(question.type, text) : null;
  const picks = text ? [text] : question.options.flatMap(({ value }) => (draft.picks.includes(value) ? [value] : []));
  const [first] = picks;
  if (first === undefined) return null;
  const comment = draft.comment.trim();
  if (question.kind === "multi") return comment ? [...picks, comment] : picks;
  return comment ? `${first} — ${comment}` : typed(question.type, first);
}

// The answer to the whole form, one per question in its order, or null while a question has none.
export function formResult(form: QuestionForm, draft: QuestionDraft): QuestionResult | null {
  const answers: Answer[] = [];
  for (const [i, question] of form.questions.entries()) {
    const answer = answerOf(question, draft.answers[i]);
    if (answer === null) return null;
    answers.push(answer);
  }
  return { action: "accept", answers };
}

// An answer as an answered card shows it: each picked option by its label.
export function answerText(question: Question, answer: Answer | undefined): string {
  const values = answer === undefined ? [] : Array.isArray(answer) ? answer : [String(answer)];
  const label = (value: string) => {
    for (const option of question.options) {
      if (value === option.value) return option.label;
      if (value.startsWith(`${option.value} — `)) return option.label + value.slice(option.value.length);
    }
    return value;
  };
  return values.map(label).join(", ");
}
