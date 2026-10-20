import { AUTO_MODEL, type CopilotPlan, type ModelOption, type ModelReport, type ReasoningEffort, type SetBotModelRequest } from "@chiefbot/contracts";

// Copilot Free's sku. Free runs every turn on Auto: the SDK accepts a model switch
// but the turn still runs on Auto's pick, so the picker locks every other model.
const FREE_SKU = "free_limited_copilot";

// Auto picks the model, so it takes no reasoning effort.
const AUTO: ModelOption = { id: AUTO_MODEL, name: "Auto", lockedReason: null, efforts: [], defaultEffort: null, vision: null };

// Catalog ids that are internal or legacy, not models a person would pick (from Chartpilot).
const HIDDEN = /^(trajectory-|gpt-3\.5|gpt-4(?!\.1)|.*-free-auto$|.*-\d{4}-\d{2}-\d{2}$)/;

// The model picker's rows for a user: Auto first, then what their plan offers.
// On Free that is the whole catalog, locked (the catalog says nothing of their
// reasoning efforts). On a paid plan it is the selectable models, with
// policy-disabled ones locked. No report yet (no worker has listed models) means Auto only.
export function modelOptions(report: ModelReport | null, plan: CopilotPlan): ModelOption[] {
  if (!report) return [AUTO];
  if (plan?.sku === FREE_SKU) {
    const names = new Map(report.selectable.map(({ id, name }) => [id, name]));
    const ids = new Set([...names.keys(), ...report.catalog].filter((id) => id !== AUTO_MODEL && !HIDDEN.test(id)));
    return [
      AUTO,
      ...[...ids].map((id) => ({
        id,
        name: names.get(id) ?? displayName(id),
        lockedReason: "Needs a paid Copilot plan",
        efforts: [],
        defaultEffort: null,
        vision: null,
      })),
    ];
  }
  return [
    AUTO,
    ...report.selectable.map(({ id, name, disabled, efforts, defaultEffort, vision }) => ({
      id,
      name,
      lockedReason: disabled ? "Turned off by your Copilot policy" : null,
      efforts,
      defaultEffort,
      vision,
    })),
  ];
}

// The model and reasoning effort a bot switches to on `request`, among the
// picker's `options`, from its `current` effort. The model must be offered and
// unlocked, and a requested effort one it supports. Without one, the bot keeps
// its effort when the new model supports it, and goes to the model's default otherwise.
export function pickModel(
  options: ModelOption[],
  { model, effort }: SetBotModelRequest,
  current: ReasoningEffort | null,
): { model: string; effort: ReasoningEffort | null } | { error: "model_unavailable" | "effort_unavailable" } {
  const option = options.find(({ id, lockedReason }) => id === model && lockedReason === null);
  if (!option) return { error: "model_unavailable" };
  const supported = (candidate: ReasoningEffort | null) => candidate === null || option.efforts.includes(candidate);
  if (effort === undefined) return { model, effort: supported(current) ? current : null };
  return supported(effort) ? { model, effort } : { error: "effort_unavailable" };
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
