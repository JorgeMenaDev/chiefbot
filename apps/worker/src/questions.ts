import type { Question, QuestionForm, QuestionResult } from "@chiefbot/contracts";
import type { ElicitationContext, ElicitationResult } from "@github/copilot-sdk";
import { z } from "zod";

// One field of an ask_user form, read leniently: the model writes the schema, so
// any part may be missing or odd. What does not parse as a choice is a typed answer.
const Choice = z.object({ const: z.string(), title: z.string() });
const Field = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  enumNames: z.array(z.string()).optional(),
  oneOf: z.array(Choice).optional(),
  items: z.object({ enum: z.array(z.string()).optional(), anyOf: z.array(Choice).optional() }).optional(),
});

// A boolean's options: the card's picks, sent back as true or false.
const yesNo = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

// The question a form's property `key` asks (contracts Question). A string enum
// (labelled by enumNames) or oneOf picks one, and an array of them picks many.
// A boolean picks yes or no, and a number or integer is typed.
function question(key: string, raw: unknown): Question {
  const field = Field.safeParse(raw).data ?? {};
  const choices = (values: string[] = [], labels: string[] = []) => values.map((value, i) => ({ value, label: labels[i] ?? value }));
  const oneOf = (list: Array<z.infer<typeof Choice>> = []) => list.map(({ const: value, title }) => ({ value, label: title }));
  const multi = field.type === "array" ? [...choices(field.items?.enum), ...oneOf(field.items?.anyOf)] : [];
  const single =
    field.type === "string" ? [...choices(field.enum, field.enumNames), ...oneOf(field.oneOf)] : field.type === "boolean" ? yesNo : [];
  const kind = multi.length > 0 ? "multi" : single.length > 0 ? "single" : "text";
  const type = kind !== "multi" && (field.type === "number" || field.type === "integer" || field.type === "boolean") ? field.type : "string";
  return { key, title: field.title ?? key, description: field.description ?? "", kind, type, options: kind === "multi" ? multi : single };
}

// The card for one of the SDK's ask_user requests, or null when it asks nothing
// Chiefbot shows: a URL-mode request, or a form without questions.
export function questionForm({ message, mode, requestedSchema }: ElicitationContext): QuestionForm | null {
  if (mode === "url" || !requestedSchema) return null;
  const [first, ...rest] = Object.entries(requestedSchema.properties).map(([key, field]) => question(key, field));
  return first ? { message, questions: [first, ...rest] } : null;
}

// The user's answer to `form` as the SDK takes it: each answer under its
// question's schema key. Object.fromEntries makes every key the content's own,
// even `__proto__`.
export function elicitationResult(form: QuestionForm, result: QuestionResult): ElicitationResult {
  if (result.action === "decline") return result;
  const content = Object.fromEntries(
    form.questions.flatMap(({ key }, i) => {
      const answer = result.answers[i];
      return answer === undefined ? [] : [[key, answer] as const];
    }),
  );
  return { action: "accept", content };
}
