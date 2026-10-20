import type { Bot, ProjectId, ScreenControl, TaskWorker } from "@chiefbot/contracts";
import { EyeIcon, HardHatIcon, MousePointer2Icon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Avatar } from "./Avatar.tsx";
import { Button } from "./components/ui/button.tsx";

// The computers whose live screen shows (LiveScreen.tsx), and the pill that says who drives one.
// A computer whose live screen shows: a bot's, or an engineer's (Engineers.tsx).
//   id       remounts the screen when it changes
//   name     its owner, for the full-screen bar and the dialog's label
//   face     drawn before the name in the full-screen bar
//   control  who drives it: the agent, or you ("human"); online says Take control can work now
//   driver   another person driving it now (an engineer's screen is shared): you only watch
//   url      its screen's WebSocket on control (main adds the session)
export type ScreenTarget = {
  id: string;
  name: string;
  face: ReactNode;
  control: ScreenControl;
  driver: string | null;
  online: boolean;
  url: () => Promise<string>;
  takeOver: () => Promise<unknown>;
  handBack: () => Promise<unknown>;
};

// The bot's computer as a screen target.
export const botScreen = (bot: Bot): ScreenTarget => ({
  id: bot.id,
  name: bot.name,
  face: <Avatar avatar={bot.avatar} className="size-5" />,
  control: bot.screenControl,
  driver: null,
  online: bot.status === "online",
  url: () => window.chiefbot.bots.screenUrl(bot.id),
  takeOver: () => window.chiefbot.bots.takeOver(bot.id),
  handBack: () => window.chiefbot.bots.handBack(bot.id),
});

// A running engineer's or verifier's screen as `login` sees it: theirs to drive
// while they hold it; another member's while that member does (`driver`).
export function engineerScreen(projectId: ProjectId, worker: TaskWorker, login: string): ScreenTarget {
  const mine = worker.screenHolder === login;
  return {
    id: worker.id,
    name: `${worker.kind === "verifier" ? "Verifier" : "Engineer"} on #${worker.taskNumber}`,
    face: <HardHatIcon className="size-4 text-muted-foreground" />,
    control: mine ? "human" : "agent",
    driver: mine ? null : worker.screenHolder,
    online: worker.state === "working",
    url: () => window.chiefbot.projects.workerScreenUrl(projectId, worker.id),
    takeOver: () => window.chiefbot.projects.takeOver(projectId, worker.id),
    handBack: () => window.chiefbot.projects.handBack(projectId, worker.id),
  };
}

// Who drives the screen and the switch, after Grok's floating pill: "Watching | Take control"
// while the agent drives, "You're in control | Stop" while the user does (take-over, hand-back),
// and "<login> is in control" with Take control off while another member drives an engineer's.
// A refused switch shows a short line under the pill, with control's reason on hover, until the next try
// or until who drives changes.
export function ControlPill({ target }: { target: ScreenTarget }) {
  const human = target.control === "human";
  const [error, setError] = useState<{ text: string; reason: string } | null>(null);
  // A switch made since (in the other pill, or by control) makes an old refusal stale:
  // one already shown goes, and one that comes back later is dropped (`switches`).
  const [control, setControl] = useState(target.control);
  if (control !== target.control) {
    setControl(target.control);
    setError(null);
  }
  // Counted as the switch commits, before any refusal can be handled against it.
  const switches = useRef(0);
  useLayoutEffect(() => {
    switches.current += 1;
  }, [target.control]);
  const toggle = () => {
    setError(null);
    const text = human ? "Couldn't hand the screen back." : "Couldn't take control.";
    const at = switches.current;
    (human ? target.handBack : target.takeOver)().catch((caught: unknown) => {
      if (switches.current === at) setError({ text, reason: caught instanceof Error ? caught.message : String(caught) });
    });
  };
  return (
    <div className="relative">
      <div role="group" aria-label="Screen control" className="dropdown-glass flex items-center gap-2 rounded-full py-1 ps-3 pe-1 text-xs shadow-lg/5">
        <span aria-live="polite" className="flex items-center gap-1.5 font-medium">
          {human ? <MousePointer2Icon className="size-3.5 text-success" /> : <EyeIcon className="size-3.5 text-muted-foreground" />}
          {human ? "You're in control" : target.driver ? `${target.driver} is in control` : "Watching"}
        </span>
        <span aria-hidden="true" className="h-4 w-px bg-border" />
        {human ? (
          <Button size="xs" variant="ghost" className="rounded-full" aria-label="Stop and hand the screen back" onClick={toggle}>
            Stop
          </Button>
        ) : (
          <Button
            size="xs"
            className="rounded-full"
            aria-label="Take control of the screen"
            disabled={!target.online || target.driver !== null}
            onClick={toggle}
          >
            Take control
          </Button>
        )}
      </div>
      {/* Under the pill without moving it, so the buttons beside it stay in line. */}
      {error && (
        <p role="alert" title={error.reason} className="absolute top-full left-1/2 mt-1 -translate-x-1/2 whitespace-nowrap text-destructive-foreground text-xs">
          {error.text}
        </p>
      )}
    </div>
  );
}
