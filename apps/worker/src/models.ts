import { AUTO_MODEL, type ModelReport } from "@chiefbot/contracts";
import { z } from "zod";
import type { SdkModelList } from "./copilot.ts";

const SdkModel = z.object({ id: z.string().min(1), name: z.string(), policy: z.object({ state: z.string() }).optional() });

// Turns the SDK's model listing into the report control keeps. Entries that do not
// look like a model are skipped, since the SDK types them as plain JSON.
export function modelReport({ list, modelPriceCategories = [] }: SdkModelList): ModelReport {
  return {
    selectable: list.flatMap((entry) => {
      const model = SdkModel.safeParse(entry);
      if (!model.success || model.data.id === AUTO_MODEL) return [];
      const { id, name, policy } = model.data;
      return [{ id, name, disabled: policy?.state === "disabled" }];
    }),
    catalog: modelPriceCategories.map(({ id }) => id),
  };
}
