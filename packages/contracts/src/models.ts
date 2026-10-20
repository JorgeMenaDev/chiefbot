import { z } from "zod";

// Copilot's Auto model: the plan picks the model for each turn. Every bot starts on it,
// and it is the only model Copilot Free can use.
export const AUTO_MODEL = "auto";

// How hard a model thinks before it answers, as the Copilot SDK names the levels
// (its ReasoningEffort). Each model supports some of them, or none.
export const ReasoningEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

// A bot's saved `effort` while its model's `efforts` still include it, else null (the
// model's default): a plan's models change, and the SDK refuses an effort its model lacks.
export const supportedEffort = (efforts: ReasoningEffort[], effort: ReasoningEffort | null) =>
  effort !== null && efforts.includes(effort) ? effort : null;

// One row of the model picker. A locked row is shown but cannot be chosen; lockedReason says why.
// `efforts` are the reasoning efforts the model supports (none: the effort picker hides),
// and `defaultEffort` the one it runs on when the bot has not chosen one. `vision` says whether
// the model reads images: null when nobody knows (Auto, a locked Free row, an older report).
export const ModelOption = z.object({
  id: z.string().min(1),
  name: z.string(),
  lockedReason: z.string().nullable(),
  efforts: z.array(ReasoningEffort),
  defaultEffort: ReasoningEffort.nullable(),
  vision: z.boolean().nullable(),
});
export type ModelOption = z.infer<typeof ModelOption>;

// What the Copilot SDK says the bot owner's plan offers, as a worker reports it.
//   selectable  models a session can switch to, Auto left out; `disabled` when a Copilot policy turns one off.
//               `efforts`, `defaultEffort` and `vision` as in ModelOption; reports from before them have none.
//   catalog     every model id in Copilot's catalog, including ones the plan cannot pick
export const ModelReport = z.object({
  selectable: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      disabled: z.boolean(),
      efforts: z.array(ReasoningEffort).default([]),
      defaultEffort: ReasoningEffort.nullable().default(null),
      vision: z.boolean().nullable().default(null),
    }),
  ),
  catalog: z.array(z.string().min(1)),
});
export type ModelReport = z.infer<typeof ModelReport>;

// Body of PUT /bots/:id/model. `effort` null runs the model on its default effort.
// Without `effort` the bot keeps its effort if the model supports it, or goes to the default.
export const SetBotModelRequest = z.object({ model: z.string().min(1), effort: ReasoningEffort.nullable().optional() });
export type SetBotModelRequest = z.infer<typeof SetBotModelRequest>;
