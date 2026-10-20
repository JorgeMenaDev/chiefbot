import { AUTO_MODEL, ReasoningEffort, type ModelReport } from "@chiefbot/contracts";
import { z } from "zod";
import type { SdkModelList } from "./copilot.ts";

// The parts of the SDK's ModelInfo the report keeps. An effort level this version
// of Chiefbot does not know is left out, rather than failing the whole model.
const SdkModel = z.object({
  id: z.string().min(1),
  name: z.string(),
  policy: z.object({ state: z.string() }).optional(),
  capabilities: z.object({ supports: z.object({ reasoningEffort: z.boolean().optional() }).optional() }).optional(),
  supportedReasoningEfforts: z.array(z.string()).optional(),
  defaultReasoningEffort: z.string().optional(),
});

// Turns the SDK's model listing into the report control keeps. Entries that do not
// look like a model are skipped, since the SDK types them as plain JSON. A model
// supports the reasoning efforts it lists only when its capabilities say it supports any.
export function modelReport({ list, modelPriceCategories = [] }: SdkModelList): ModelReport {
  return {
    selectable: list.flatMap((entry) => {
      const model = SdkModel.safeParse(entry);
      if (!model.success || model.data.id === AUTO_MODEL) return [];
      const { id, name, policy, capabilities, supportedReasoningEfforts = [], defaultReasoningEffort } = model.data;
      const efforts = capabilities?.supports?.reasoningEffort ? supportedReasoningEfforts.flatMap((effort) => ReasoningEffort.safeParse(effort).data ?? []) : [];
      const defaultEffort = efforts.find((effort) => effort === defaultReasoningEffort) ?? null;
      return [{ id, name, disabled: policy?.state === "disabled", efforts, defaultEffort }];
    }),
    catalog: modelPriceCategories.map(({ id }) => id),
  };
}
