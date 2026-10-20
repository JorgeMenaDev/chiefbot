import { z } from "zod";

// A bot's question to its user: a form from Copilot's ask_user tool, which the
// desktop shows as a card in the chat. The worker reads the SDK's form (one
// schema property per question) into this shape; control stores it and checks
// the answer against it.

// One suggested answer: `value` goes back to the agent, `label` is what the card shows.
export const QuestionOption = z.object({ value: z.string(), label: z.string() });
export type QuestionOption = z.infer<typeof QuestionOption>;

// One question of a form, answered under its schema property `key`.
//   single  pick one option (a string enum or oneOf)
//   multi   pick any options (a string array whose items are an enum or anyOf)
//   text    type the answer (a plain string, number or boolean)
// Options are suggestions: the user may always type an answer of their own.
export const Question = z.object({
  key: z.string().min(1),
  title: z.string(),
  description: z.string(),
  kind: z.enum(["single", "multi", "text"]),
  options: z.array(QuestionOption),
});
export type Question = z.infer<typeof Question>;

// What the agent asks: its message, and its questions (at least one) in the schema's order.
export const QuestionForm = z.object({ message: z.string(), questions: z.tuple([Question], Question) });
export type QuestionForm = z.infer<typeof QuestionForm>;

// One answer as the user typed or picked it: never empty.
const AnswerText = z.string().trim().min(1).max(20_000);

// The user's answer to a form: every question answered (accept), or none (decline).
// It is also the body of POST /bots/:id/questions/:questionId. A single or text
// question's answer is a string, a multi question's a list of strings.
export const QuestionResult = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), content: z.record(z.string(), z.union([AnswerText, z.array(AnswerText).min(1)])) }),
  z.object({ action: z.literal("decline") }),
]);
export type QuestionResult = z.infer<typeof QuestionResult>;

// The content an accepted answer to `form` must have: one answer under each
// question's key, and nothing else. Values need not be among the options.
export const formContent = (form: QuestionForm) =>
  z.strictObject(
    Object.fromEntries(form.questions.map(({ key, kind }) => [key, kind === "multi" ? z.array(AnswerText).min(1) : AnswerText])),
  );
