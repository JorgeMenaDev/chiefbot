// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/chat/: the
// composer footer's controls in ChatComposer.tsx (model, then traits, then runtime mode), the effort
// menu of TraitsPicker.tsx, the runtime modes of runtimeModeConfig.ts, and CompactComposerControlsMenu.tsx.
import { AccessMode, ModelOption, supportedEffort, type Bot, type ReasoningEffort, type SetBotModelRequest } from "@chiefbot/contracts";
import { BrainIcon, EllipsisIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { z } from "zod";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon, ComposerControlSeparator } from "./ComposerControl.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { MenuGroupLabel, MenuPopup, MenuRadioItem, MenuSeparator } from "./components/ui/menu.tsx";

const ModelList = z.array(ModelOption);

// T3 Code's names for the effort levels.
const effortLabel: Record<ReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

// T3 Code's runtime modes, as a bot's access modes (contracts AccessMode, the worker's approvals.ts).
// Control asks before every push and pull request in every mode, so Full access says so.
const accessModes: Record<AccessMode, { label: string; description: string; icon: LucideIcon }> = {
  supervised: { label: "Supervised", description: "Asks before every command, file change, tool or anything else that may change things.", icon: LockIcon },
  "auto-accept-edits": { label: "Auto-accept edits", description: "Changes files without asking. Asks before anything else that may change things.", icon: PenLineIcon },
  auto: { label: "Auto", description: "Asks only before connection changes and GitHub writes.", icon: SparklesIcon },
  "full-access": {
    label: "Full access",
    description: "Runs every command and connection change without asking. Pushes and pull requests still ask.",
    icon: LockOpenIcon,
  },
};

// The model picker's rows for the user's plan, read on mount and again by
// `refresh` (each time the model list opens), so a new report shows.
export function useModels() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const refresh = useCallback(() => void window.chiefbot.bots.models().then((next) => setModels(ModelList.parse(next))), []);
  useEffect(refresh, [refresh]);
  return { models, refresh };
}

// The bot composer's footer controls, as T3 Code lays them out: the model (among
// `models`, from useModels), then (when the model takes one) its reasoning effort,
// then the access mode. When the composer is narrow, effort and access fold into
// one "…" menu. Each pick is saved on the bot in control, so its next turn runs on
// it; control's refusal goes to `onError`.
export function BotComposerControls({
  bot,
  models: { models, refresh },
  onError,
}: {
  bot: Bot;
  models: ReturnType<typeof useModels>;
  onError: (message: string | null) => void;
}) {
  const model = models.find(({ id }) => id === bot.model);
  const efforts = model?.efforts ?? [];
  // A saved effort the model no longer offers runs as its default, as control sends it.
  const effort = supportedEffort(efforts, bot.effort);

  async function save(change: () => Promise<unknown>) {
    onError(null);
    try {
      await change();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }
  const setModel = (request: SetBotModelRequest) => save(() => window.chiefbot.bots.setModel(bot.id, request));
  const setEffort = (next: ReasoningEffort | null) => setModel({ model: bot.model, effort: next });
  const setAccess = (next: AccessMode) => save(() => window.chiefbot.bots.setAccess(bot.id, next));

  return (
    <>
      <ModelPicker model={bot.model} models={models} onOpen={refresh} onPick={({ id }) => void setModel({ model: id })} />
      <span className="contents @max-[34rem]/composer:hidden">
        {efforts.length > 0 && (
          <>
            <ComposerControlSeparator />
            <EffortPicker efforts={efforts} effort={effort} defaultEffort={model?.defaultEffort ?? null} onChange={setEffort} />
          </>
        )}
        <ComposerControlSeparator />
        <AccessModePicker access={bot.access} onChange={setAccess} />
      </span>
      <span className="contents @min-[34rem]/composer:hidden">
        <CompactComposerControlsMenu
          efforts={efforts}
          effort={effort}
          defaultEffort={model?.defaultEffort ?? null}
          access={bot.access}
          onEffortChange={setEffort}
          onAccessChange={setAccess}
        />
      </span>
    </>
  );
}

// `effort` null is the model's default, which `defaultEffort` names when the model reports one.
type EffortProps = {
  efforts: ReasoningEffort[];
  effort: ReasoningEffort | null;
  defaultEffort: ReasoningEffort | null;
  onChange: (effort: ReasoningEffort | null) => void;
};

// The menu's effort choices, after TraitsMenuContent: Default (null, whatever the
// model's default is), then each level the model supports, the default one marked.
function EffortItems({ menu, efforts, effort, defaultEffort, onChange }: EffortProps & { menu: string }) {
  return (
    <>
      <MenuGroupLabel>Reasoning effort</MenuGroupLabel>
      <MenuRadioItem menu={menu} checked={effort === null} onClick={() => onChange(null)}>
        <span className="min-w-0 truncate">Default</span>
      </MenuRadioItem>
      {efforts.map((level) => (
        <MenuRadioItem key={level} menu={menu} checked={level === effort} onClick={() => onChange(level)}>
          <span className="min-w-0 truncate">{effortLabel[level]}</span>
          {level === defaultEffort && (
            <Badge variant="outline" size="sm">
              Model default
            </Badge>
          )}
        </MenuRadioItem>
      ))}
    </>
  );
}

// The model's reasoning effort, after T3 Code's TraitsPicker: a brain, the level (or Default), a chevron.
export function EffortPicker(props: EffortProps) {
  const menu = useId();
  const [open, setOpen] = useState(false);
  const label = props.effort ? effortLabel[props.effort] : "Default";
  return (
    <>
      <ComposerControl popoverTarget={menu} aria-label={`Reasoning effort: ${label}`} aria-expanded={open}>
        <ComposerControlIcon icon={BrainIcon} />
        {label}
        <ComposerControlChevron />
      </ComposerControl>
      <MenuPopup id={menu} aria-label="Reasoning effort" className="min-w-44" onOpenChange={setOpen}>
        <EffortItems menu={menu} {...props} />
      </MenuPopup>
    </>
  );
}

type AccessProps = { access: AccessMode; onChange: (access: AccessMode) => void };

// The menu's access modes, each with what it means, after T3 Code's runtime mode select.
function AccessItems({ menu, access, onChange }: AccessProps & { menu: string }) {
  return AccessMode.options.map((mode) => {
    const { label, description, icon: Icon } = accessModes[mode];
    return (
      <MenuRadioItem key={mode} menu={menu} checked={mode === access} onClick={() => onChange(mode)} className="py-1.5">
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <Icon className="size-3.5 text-muted-foreground" />
            {label}
          </span>
          <span className="text-muted-foreground text-xs leading-4">{description}</span>
        </span>
      </MenuRadioItem>
    );
  });
}

// The bot's access mode, after T3 Code's runtime mode select: its icon and name, a chevron.
function AccessModePicker(props: AccessProps) {
  const menu = useId();
  const [open, setOpen] = useState(false);
  const { label, icon } = accessModes[props.access];
  return (
    <>
      <ComposerControl popoverTarget={menu} aria-label={`Access: ${label}`} aria-expanded={open}>
        <ComposerControlIcon icon={icon} />
        {label}
        <ComposerControlChevron />
      </ComposerControl>
      <MenuPopup id={menu} aria-label="Access" className="w-72" onOpenChange={setOpen}>
        <AccessItems menu={menu} {...props} />
      </MenuPopup>
    </>
  );
}

// Effort and access in one "…" menu, for a narrow composer (T3 Code's CompactComposerControlsMenu).
function CompactComposerControlsMenu({
  efforts,
  effort,
  defaultEffort,
  access,
  onEffortChange,
  onAccessChange,
}: Omit<EffortProps, "onChange"> & { access: AccessMode; onEffortChange: EffortProps["onChange"]; onAccessChange: AccessProps["onChange"] }) {
  const menu = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <ComposerControl popoverTarget={menu} aria-label="More composer controls" aria-expanded={open} className="px-2">
        <ComposerControlIcon icon={EllipsisIcon} />
      </ComposerControl>
      <MenuPopup id={menu} aria-label="Composer controls" className="w-72" onOpenChange={setOpen}>
        {efforts.length > 0 && (
          <>
            <EffortItems menu={menu} efforts={efforts} effort={effort} defaultEffort={defaultEffort} onChange={onEffortChange} />
            <MenuSeparator />
          </>
        )}
        <MenuGroupLabel>Access</MenuGroupLabel>
        <AccessItems menu={menu} access={access} onChange={onAccessChange} />
      </MenuPopup>
    </>
  );
}
