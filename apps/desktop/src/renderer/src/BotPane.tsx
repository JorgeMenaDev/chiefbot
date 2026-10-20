import type { Bot, BotStatus } from "@chiefbot/contracts";
import { PanelRightIcon, PowerIcon, PowerOffIcon, Trash2Icon } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import { Avatar } from "./Avatar.tsx";
import { Chat } from "./Chat.tsx";
import { ConnectionCalls } from "./ConnectApps.tsx";
import { ScreenPane } from "./LiveScreen.tsx";
import { Column, ErrorText, PaneHeader, PanelSection, SidePanel } from "./Pane.tsx";
import { Routines } from "./Routines.tsx";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";

// Whether the bot details panel is open survives a restart and applies to every bot.
const detailsKey = "chiefbot.botDetails";

// The selected bot: its chat in the middle, its details panel on the right.
// `draft` starts the composer with a message (Health's Ask my bot).
export function BotPane({ bot, draft }: { bot: Bot; draft?: string | undefined }) {
  const [details, setDetails] = useState(() => localStorage.getItem(detailsKey) !== "closed");
  const showDetails = (open: boolean) => {
    setDetails(open);
    localStorage.setItem(detailsKey, open ? "open" : "closed");
  };
  return (
    <>
      <Column>
        <PaneHeader icon={<BotFace bot={bot} className="size-6" dotClassName="-end-1 -bottom-1 bg-background" />} title={bot.name} note={`${statusText[bot.status]} · runs on your Copilot seat`}>
          {!details && <DetailsToggle open={false} onClick={() => showDetails(true)} />}
        </PaneHeader>
        <Chat bot={bot} initialDraft={draft} />
      </Column>
      {/* Closed, the panel stays mounted but hidden, so the bot's screen stays open. */}
      <BotDetails bot={bot} hidden={!details} onClose={() => showDetails(false)} />
    </>
  );
}

// Shows or hides the details panel. It sits at the window's top-right corner either
// way: at the end of the chat header while the panel is closed, in the panel's bar while open.
function DetailsToggle({ open, className, onClick }: { open: boolean; className?: string; onClick: () => void }) {
  return (
    <Button size="icon-xs" variant="ghost" pressed={open} className={className} aria-label="Bot details" title={open ? "Hide details" : "Show details"} onClick={onClick}>
      <PanelRightIcon />
    </Button>
  );
}

// A bot's face with its status dot pinned to the corner (chat header, sidebar rows).
// `className` sizes the face; `dotClassName` places the dot and backs it with the colour behind it.
export function BotFace({ bot, className, dotClassName }: { bot: Bot; className: string; dotClassName: string }) {
  return (
    <span className="relative shrink-0">
      <Avatar avatar={bot.avatar} className={className} />
      <span className={cn("absolute rounded-full", dotClassName)}>
        <StatusDot status={bot.status} />
      </span>
    </span>
  );
}

const tabs = [
  ["details", "Details"],
  ["computer", "Computer"],
] as const;

type Tab = (typeof tabs)[number][0];

// The bot's avatar and name over two tabs: Details (status, routines, delete)
// and Computer (its live screen). Both tabs stay mounted, the other one hidden
// (the routines list aside): an open screen counts as activity, so the selected
// bot does not idle-stop while the user is on Details or has closed the panel.
function BotDetails({ bot, hidden, onClose }: { bot: Bot; hidden: boolean; onClose: () => void }) {
  const { start, stop, remove } = window.chiefbot.bots;
  const [tab, setTab] = useState<Tab>("details");
  const [error, setError] = useState<string | null>(null);
  // Runs Start, Stop or Delete. Control's refusal (such as while the bot's
  // computer is still being made) shows under its status.
  const act = (change: () => Promise<unknown>) => {
    setError(null);
    change().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  };
  const id = useId();
  const tabId = (key: Tab) => `${id}-tab-${key}`;
  const panelId = (key: Tab) => `${id}-panel-${key}`;
  // Arrow keys, Home and End move between the tabs (the WAI-ARIA tabs pattern).
  const onTabKey = (event: KeyboardEvent) => {
    const index = tabs.findIndex(([key]) => key === tab);
    const moves: Partial<Record<string, number>> = { ArrowRight: index + 1, ArrowLeft: index - 1 + tabs.length, Home: 0, End: tabs.length - 1 };
    const next = moves[event.key];
    const target = next === undefined ? undefined : tabs[next % tabs.length];
    if (!target) return;
    event.preventDefault();
    setTab(target[0]);
    document.getElementById(tabId(target[0]))?.focus();
  };
  return (
    <SidePanel
      hidden={hidden}
      bar={
        <DetailsToggle open className="ms-auto" onClick={onClose} />
      }
    >
      <div className="flex flex-col items-center gap-3 px-5 pt-6 pb-5 text-center">
        <Avatar avatar={bot.avatar} className="size-20" />
        <h2 className="max-w-full truncate font-semibold text-lg">{bot.name}</h2>
        <div role="tablist" aria-label="Bot" className="flex w-full rounded-lg bg-muted p-0.5" onKeyDown={onTabKey}>
          {tabs.map(([key, label]) => (
            <button
              key={key}
              id={tabId(key)}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-controls={panelId(key)}
              tabIndex={tab === key ? 0 : -1}
              className={cn(
                "flex-1 cursor-pointer rounded-md py-1 font-medium text-sm transition-colors",
                tab === key ? "bg-background text-foreground shadow-xs dark:bg-input/64" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id={panelId("computer")} aria-labelledby={tabId("computer")} hidden={tab !== "computer"}>
        <ScreenPane bot={bot} />
      </div>
      <div role="tabpanel" id={panelId("details")} aria-labelledby={tabId("details")} hidden={tab !== "details"}>
        <PanelSection title="Status">
          <div className="flex items-center gap-3">
            <StatusDot status={bot.status} />
            <p className="min-w-0 flex-1 text-muted-foreground text-xs">{statusText[bot.status]}</p>
            {bot.status === "stopped" ? (
              <Button size="xs" variant="outline" onClick={() => act(() => start(bot.id))}>
                <PowerIcon />
                Start
              </Button>
            ) : (
              <Button size="xs" variant="outline" onClick={() => act(() => stop(bot.id))} disabled={bot.status === "stopping"}>
                <PowerOffIcon />
                Stop
              </Button>
            )}
          </div>
          <ErrorText message={error} />
        </PanelSection>
        {/* Mounted only while shown, so it reloads each time Details shows (a routine may have run). */}
        {!hidden && tab === "details" && <Routines bot={bot} />}
        {!hidden && tab === "details" && <ConnectionCalls bot={bot} />}
        <PanelSection title="Delete">
          <Button size="xs" variant="destructive-outline" className="self-start" onClick={() => act(() => remove(bot.id))}>
            <Trash2Icon />
            Delete {bot.name}
          </Button>
        </PanelSection>
      </div>
    </SidePanel>
  );
}

const statusText: Record<BotStatus, string> = {
  starting: "Its computer is starting. The bot comes online when its worker connects.",
  online: "Online. Its worker is connected.",
  stopping: "Its computer is stopping. It takes no new messages, routine runs or screen viewers.",
  stopped: "Stopped. Its files are kept.",
};

// Colour per status, with a ping while starting or stopping (after T3 Code's ConnectionStatusDot).
const dotColor: Record<BotStatus, string> = {
  online: "bg-success",
  starting: "bg-warning",
  stopping: "bg-muted-foreground/40",
  stopped: "bg-muted-foreground/40",
};
const pingColor: Record<BotStatus, string | null> = {
  online: null,
  starting: "bg-warning/60",
  stopping: "bg-muted-foreground/30",
  stopped: null,
};

export function StatusDot({ status }: { status: BotStatus }) {
  const ping = pingColor[status];
  return (
    <span className="relative flex size-3 shrink-0 items-center justify-center" aria-label={status}>
      {ping && <span className={cn("absolute inline-flex size-full animate-status-ping rounded-full", ping)} />}
      <span className={cn("relative inline-flex size-2 rounded-full", dotColor[status])} />
    </span>
  );
}
