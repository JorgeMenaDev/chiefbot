import { z } from "zod";

// A bot's question to its user: a form from Copilot's ask_user tool, which the
// desktop shows as a card in the chat. The worker reads the SDK's form (one
// schema property per question) into this shape; control stores it and checks
// the answer against it.

// One suggested answer: `value` goes back to the agent, `label` is what the card shows.
export const QuestionOption = z.object({ value: z.string(), label: z.string() });
export type QuestionOption = z.infer<typeof QuestionOption>;

// One question of a form, answered under its schema property `key`.
//   single  pick one option (a string enum or oneOf, or yes/no for a boolean)
//   multi   pick any options (a string array whose items are an enum or anyOf)
//   text    type the answer (a plain string, number or integer)
// `type` is the JSON type the schema wants for a single or text answer; a multi
// question's answers are strings. Options are suggestions: the user may always
// type an answer of their own.
export const Question = z.object({
  key: z.string().min(1),
  title: z.string(),
  description: z.string(),
  kind: z.enum(["single", "multi", "text"]),
  type: z.enum(["string", "number", "integer", "boolean"]),
  options: z.array(QuestionOption),
});
export type Question = z.infer<typeof Question>;

// What the agent asks: its message, and its questions (at least one) in the schema's order.
export const QuestionForm = z.object({ message: z.string(), questions: z.tuple([Question], Question) });
export type QuestionForm = z.infer<typeof QuestionForm>;

// One answer as the user typed or picked it: never empty.
const AnswerText = z.string().trim().min(1).max(20_000);
const Picks = z.array(AnswerText).min(1);

// One question's answer: a multi question's picks, or a single or text
// question's answer, as a number or boolean when its `type` asks for one and the
// answer reads as one.
export const Answer = z.union([AnswerText, z.number(), z.boolean(), Picks]);
export type Answer = z.infer<typeof Answer>;

// The user's answer to a form: every question answered (accept), or none (decline).
// It is also the body of POST /bots/:id/questions/:questionId. `answers[i]`
// answers the form's `questions[i]`: a list rather than a record by key, so any
// schema key (even `__proto__`) is safe. The worker keys them for the SDK.
export const QuestionResult = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), answers: z.array(Answer).min(1) }),
  z.object({ action: z.literal("decline") }),
]);
export type QuestionResult = z.infer<typeof QuestionResult>;

// What may answer `question`: its picks, its type's value, or an answer of the user's own.
const answerTo = ({ kind, type }: Question) => {
  if (kind === "multi") return Picks;
  if (type === "number") return z.union([z.number(), AnswerText]);
  if (type === "integer") return z.union([z.int(), AnswerText]);
  if (type === "boolean") return z.union([z.boolean(), AnswerText]);
  return AnswerText;
};

// The answers an accepted answer to `form` must have: one per question, in its
// order. Values need not be among the options.
export const formAnswers = ({ questions: [first, ...rest] }: QuestionForm) => z.tuple([answerTo(first), ...rest.map(answerTo)]);
