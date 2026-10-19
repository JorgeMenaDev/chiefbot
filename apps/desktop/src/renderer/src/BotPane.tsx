import type { Bot, BotStatus } from "@chiefbot/contracts";
import { PanelRightIcon, PowerIcon, PowerOffIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { Chat } from "./Chat.tsx";
import { ScreenPane } from "./LiveScreen.tsx";
import { Column, PaneHeader, PanelSection, SidePanel } from "./Pane.tsx";
import { Routines } from "./Routines.tsx";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";

// Whether the bot details panel is open survives a restart and applies to every bot.
const detailsKey = "chiefbot.botDetails";

// The selected bot: its chat in the middle, its details panel on the right.
export function BotPane({ bot }: { bot: Bot }) {
  const [details, setDetails] = useState(() => localStorage.getItem(detailsKey) !== "closed");
  const showDetails = (open: boolean) => {
    setDetails(open);
    localStorage.setItem(detailsKey, open ? "open" : "closed");
  };
  return (
    <>
      <Column>
        <PaneHeader icon={<StatusDot status={bot.status} />} title={bot.name} note={`${statusText[bot.status]} · runs on your Copilot seat`}>
          <Button
            size="icon-xs"
            variant="ghost"
            pressed={details}
            aria-label="Bot details"
            title={details ? "Hide details" : "Show details"}
            onClick={() => showDetails(!details)}
          >
            <PanelRightIcon />
          </Button>
        </PaneHeader>
        <Chat bot={bot} />
      </Column>
      {details && <BotDetails bot={bot} onClose={() => showDetails(false)} />}
    </>
  );
}

const tabs = [
  ["details", "Details"],
  ["computer", "Computer"],
] as const;

// The bot's avatar and name over two tabs: Details (status, routines, delete)
// and Computer (its live screen).
function BotDetails({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const { start, stop, remove } = window.chiefbot.bots;
  const [tab, setTab] = useState<(typeof tabs)[number][0]>("details");
  return (
    <SidePanel
      bar={
        <Button size="icon-xs" variant="ghost" className="ms-auto" aria-label="Close details" title="Close details" onClick={onClose}>
          <XIcon />
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-3 px-5 pt-6 pb-5 text-center">
        <span className="flex size-20 items-center justify-center rounded-full border bg-muted font-semibold text-3xl uppercase">
          {bot.name.slice(0, 1)}
        </span>
        <h2 className="max-w-full truncate font-semibold text-lg">{bot.name}</h2>
        <div role="tablist" className="flex w-full rounded-lg bg-muted p-0.5">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
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
      {tab === "computer" ? (
        <ScreenPane bot={bot} />
      ) : (
        <>
          <PanelSection title="Status">
            <div className="flex items-center gap-3">
              <StatusDot status={bot.status} />
              <p className="min-w-0 flex-1 text-muted-foreground text-xs">{statusText[bot.status]}</p>
              {bot.status === "stopped" ? (
                <Button size="xs" variant="outline" onClick={() => void start(bot.id)}>
                  <PowerIcon />
                  Start
                </Button>
              ) : (
                <Button size="xs" variant="outline" onClick={() => void stop(bot.id)} disabled={bot.status === "stopping"}>
                  <PowerOffIcon />
                  Stop
                </Button>
              )}
            </div>
          </PanelSection>
          <Routines bot={bot} />
          <PanelSection title="Delete">
            <Button size="xs" variant="destructive-outline" className="self-start" onClick={() => void remove(bot.id)}>
              <Trash2Icon />
              Delete {bot.name}
            </Button>
          </PanelSection>
        </>
      )}
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
