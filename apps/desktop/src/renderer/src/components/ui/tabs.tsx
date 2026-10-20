import { useId, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

// One tab: its key, its label, and anything after the label (a count).
export type TabItem<Key extends string> = { key: Key; label: string; note?: ReactNode; title?: string };

// Tabs in a pill, after T3 Code's toggle group (the bot panel's Details | Computer,
// the sidebar's Bots | Projects, a project's Tasks | Engineers | Context). Only the
// selected tab is in the tab order; arrow keys, Home and End move between them
// (the WAI-ARIA tabs pattern). `ids` names each tab and its panel (useTabIds).
export function Tabs<Key extends string>({
  label,
  tabs,
  value,
  ids,
  onChange,
  className,
}: {
  label: string;
  tabs: ReadonlyArray<TabItem<Key>>;
  value: Key;
  ids: TabIds<Key>;
  onChange: (key: Key) => void;
  className?: string;
}) {
  const onKeyDown = (event: KeyboardEvent) => {
    const index = tabs.findIndex(({ key }) => key === value);
    const moves: Partial<Record<string, number>> = { ArrowRight: index + 1, ArrowLeft: index - 1 + tabs.length, Home: 0, End: tabs.length - 1 };
    const next = moves[event.key];
    const target = next === undefined ? undefined : tabs[next % tabs.length];
    if (!target) return;
    event.preventDefault();
    onChange(target.key);
    document.getElementById(ids.tab(target.key))?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={cn("flex rounded-lg bg-muted p-0.5", className)} onKeyDown={onKeyDown}>
      {tabs.map(({ key, label: text, note, title }) => (
        <button
          key={key}
          id={ids.tab(key)}
          type="button"
          role="tab"
          title={title}
          aria-selected={value === key}
          aria-controls={ids.panel(key)}
          tabIndex={value === key ? 0 : -1}
          className={cn(
            "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1 font-medium text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            value === key ? "bg-background text-foreground shadow-xs dark:bg-input/64" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onChange(key)}
        >
          {text}
          {note}
        </button>
      ))}
    </div>
  );
}

// The panel of one tab. Hidden ones stay mounted, so what they hold (a live screen, a draft) stays.
export function TabPanel<Key extends string>({
  ids,
  tab,
  value,
  className,
  children,
}: {
  ids: TabIds<Key>;
  tab: Key;
  value: Key;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="tabpanel" id={ids.panel(tab)} aria-labelledby={ids.tab(tab)} hidden={value !== tab} className={className}>
      {children}
    </div>
  );
}

export type TabIds<Key extends string> = { tab: (key: Key) => string; panel: (key: Key) => string };

// Element ids for one set of tabs and their panels, unique on the page.
export function useTabIds<Key extends string>(): TabIds<Key> {
  const id = useId();
  return { tab: (key) => `${id}-tab-${key}`, panel: (key) => `${id}-panel-${key}` };
}
