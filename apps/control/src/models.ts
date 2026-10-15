import { AUTO_MODEL, type CopilotPlan, type ModelOption, type ModelReport } from "@chiefbot/contracts";

// Copilot Free's sku. Free runs every turn on Auto: the SDK accepts a model switch
// but the turn still runs on Auto's pick, so the picker locks every other model.
const FREE_SKU = "free_limited_copilot";

const AUTO: ModelOption = { id: AUTO_MODEL, name: "Auto", lockedReason: null };

// Catalog ids that are internal or legacy, not models a person would pick (from Chartpilot).
const HIDDEN = /^(trajectory-|gpt-3\.5|gpt-4(?!\.1)|.*-free-auto$|.*-\d{4}-\d{2}-\d{2}$)/;

// The model picker's rows for a user: Auto first, then what their plan offers.
// On Free that is the whole catalog, locked. On a paid plan it is the selectable
// models, with policy-disabled ones locked. No report yet (no worker has listed
// models) means Auto only.
export function modelOptions(report: ModelReport | null, plan: CopilotPlan): ModelOption[] {
  if (!report) return [AUTO];
  if (plan?.sku === FREE_SKU) {
    const names = new Map(report.selectable.map(({ id, name }) => [id, name]));
    const ids = new Set([...names.keys(), ...report.catalog].filter((id) => id !== AUTO_MODEL && !HIDDEN.test(id)));
    return [
      AUTO,
      ...[...ids].map((id) => ({ id, name: names.get(id) ?? displayName(id), lockedReason: "Needs a paid Copilot plan" })),
    ];
  }
  return [
    AUTO,
    ...report.selectable.map(({ id, name, disabled }) => ({
      id,
      name,
      lockedReason: disabled ? "Turned off by your Copilot policy" : null,
    })),
  ];
}

// "claude-haiku-4.5" → "Claude Haiku 4.5", "gpt-6-luna" → "GPT-6 Luna", for catalog ids without a name.
function displayName(id: string) {
  return id
    .replace(/^gpt-(\d)/, "gpt$1")
    .split("-")
    .map((word) =>
      word === "mai" ? "MAI" : word.replace(/^gpt(\d)/, "GPT-$1").replace(/^\w/, (first) => first.toUpperCase()),
    )
    .join(" ");
}
