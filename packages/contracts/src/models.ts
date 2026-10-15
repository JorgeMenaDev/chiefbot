import { z } from "zod";

// Copilot's Auto model: the plan picks the model for each turn. Every bot starts on it,
// and it is the only model Copilot Free can use.
export const AUTO_MODEL = "auto";

// One row of the model picker. A locked row is shown but cannot be chosen; lockedReason says why.
export const ModelOption = z.object({ id: z.string().min(1), name: z.string(), lockedReason: z.string().nullable() });
export type ModelOption = z.infer<typeof ModelOption>;

// What the Copilot SDK says the bot owner's plan offers, as a worker reports it.
//   selectable  models a session can switch to, Auto left out; `disabled` when a Copilot policy turns one off
//   catalog     every model id in Copilot's catalog, including ones the plan cannot pick
export const ModelReport = z.object({
  selectable: z.array(z.object({ id: z.string().min(1), name: z.string(), disabled: z.boolean() })),
  catalog: z.array(z.string().min(1)),
});
export type ModelReport = z.infer<typeof ModelReport>;

// Body of PUT /bots/:id/model.
export const SetBotModelRequest = z.object({ model: z.string().min(1) });
export type SetBotModelRequest = z.infer<typeof SetBotModelRequest>;
