import { AUTO_MODEL, type Bot, type ModelOption } from "@chiefbot/contracts";
import { CheckIcon, LockIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { ComposerControl, ComposerControlChevron } from "./ComposerControl.tsx";
import { cn } from "./lib/utils.ts";

// The bot's model, after T3 Code's ProviderModelPicker and ModelListRow (via
// Chartpilot's port): a composer control with the Copilot mark and the model's
// name, opening a searchable list of the plan's `models` above the composer. Locked
// rows show why in place of the provider line and cannot be picked. The list sits in
// the top layer (a popover), so nothing clips it; a click outside or Escape closes
// it. `onOpen` runs each time it opens (to read the plan's models again), `onPick`
// with the model picked.
export function ModelPicker({
  bot,
  models,
  onOpen,
  onPick,
}: {
  bot: Bot;
  models: ModelOption[];
  onOpen: () => void;
  onPick: (model: ModelOption) => void;
}) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const name = models.find((model) => model.id === bot.model)?.name ?? (bot.model === AUTO_MODEL ? "Auto" : bot.model);
  const q = query.trim().toLowerCase();
  const visible = q ? models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(q)) : models;

  function choose(model: ModelOption) {
    if (model.lockedReason !== null) return;
    popup.current?.hidePopover();
    onPick(model);
  }

  return (
    <>
      <ComposerControl popoverTarget={id} aria-label={`Model: ${name}`} aria-expanded={open} className="-ms-1 min-w-0 max-w-56 justify-between">
        <CopilotIcon className="size-4 text-muted-foreground" />
        <span className="min-w-0 truncate">{name}</span>
        <ComposerControlChevron />
      </ComposerControl>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="dialog"
        aria-label="Models"
        className="m-0 mb-1.5 max-h-[346px] w-[360px] flex-col overflow-hidden rounded-lg border bg-popover/94 text-popover-foreground shadow-lg/10 backdrop-blur-xl [position-area:top_span-right] [position-try-fallbacks:flip-block] open:flex"
        onToggle={(event) => {
          const opened = event.newState === "open";
          setOpen(opened);
          if (!opened) return setQuery("");
          onOpen();
          search.current?.focus();
        }}
      >
        <input
          ref={search}
          className="mx-3 mt-2.5 border-b bg-transparent pb-1.5 text-sm outline-none placeholder:text-muted-foreground/72 focus:border-ring"
          placeholder="Search models..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div role="listbox" className="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-1.5">
          {visible.map((model) => (
            <ModelRow key={model.id} model={model} selected={model.id === bot.model} onSelect={() => choose(model)} />
          ))}
          {visible.length === 0 && <p className="px-2 py-3 text-center text-muted-foreground text-xs">No models found</p>}
        </div>
      </div>
    </>
  );
}

function ModelRow({ model, selected, onSelect }: { model: ModelOption; selected: boolean; onSelect: () => void }) {
  const locked = model.lockedReason !== null;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={locked}
      title={model.lockedReason ?? undefined}
      className="flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-64 aria-disabled:hover:bg-transparent aria-selected:bg-accent"
      onClick={onSelect}
    >
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="truncate font-medium text-xs">{model.name}</span>
        <span className="flex items-center gap-1.5 text-muted-foreground/80 text-xs">
          <CopilotIcon className="size-3" />
          {model.lockedReason ?? "GitHub Copilot"}
        </span>
      </span>
      {locked ? (
        <LockIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Locked" />
      ) : (
        selected && <CheckIcon className="size-4 shrink-0 text-muted-foreground" aria-label="Selected" />
      )}
    </button>
  );
}

// GitHub Copilot's mark (GitHub's Octicons, MIT), as T3 Code shows it for the Copilot provider.
function CopilotIcon({ className }: { className: string }) {
  return (
    <svg className={cn("shrink-0 fill-current", className)} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" />
    </svg>
  );
}
