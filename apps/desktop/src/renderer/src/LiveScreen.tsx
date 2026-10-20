import type { Bot } from "@chiefbot/contracts";
import RFB from "@novnc/novnc";
import { EyeIcon, Maximize2Icon, Minimize2Icon, MousePointer2Icon, PowerIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Avatar, type AvatarMood } from "./Avatar.tsx";
import { ErrorText } from "./Pane.tsx";
import { Button } from "./components/ui/button.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { afterDisconnect, computerView, type ComputerView } from "./computerView.ts";
import { cn } from "./lib/utils.ts";

// The details panel's Computer tab. While the bot is online it shows the bot's live screen
// through control, with full screen and the control pill. Otherwise it shows the bot's face:
// waking up, going to sleep, asleep (Wake) or unreachable (Try again). The user watches until
// they take control; then mouse and keyboard go to the bot's computer and the agent waits.
export function ScreenPane({ bot }: { bot: Bot }) {
  const [failures, setFailures] = useState(0);
  // Each new status counts failed screen connections afresh.
  const [status, setStatus] = useState(bot.status);
  if (status !== bot.status) {
    setStatus(bot.status);
    setFailures(0);
  }
  const view = computerView(bot.status, failures);
  return (
    <div className="flex flex-col gap-3 border-t px-5 py-4">
      {view === "live" ? (
        <LiveScreen key={bot.id} bot={bot} setFailures={setFailures} />
      ) : (
        <>
          <ComputerFace bot={bot} view={view} onRetry={() => setFailures(0)} />
          {/* The user can always hand the screen back, even while the bot is offline. */}
          {bot.screenControl === "human" && <ControlPill bot={bot} />}
        </>
      )}
    </div>
  );
}

const faces: Record<Exclude<ComputerView, "live">, { mood: AvatarMood; title: string; line: string; shimmer?: true }> = {
  waking: { mood: "gaze", title: "Waking up…", line: "Its computer is starting.", shimmer: true },
  sleeping: { mood: "sleep", title: "Going to sleep…", line: "Its computer is stopping. Its files are kept.", shimmer: true },
  asleep: { mood: "sleep", title: "Asleep", line: "Its computer is stopped. Its files are kept." },
  unreachable: { mood: "blink", title: "Can't reach the computer", line: "Its screen did not connect." },
};

// The bot's face where its screen would be, after Grok's: its mood and a title for the state,
// with Wake while asleep and Try again while unreachable.
function ComputerFace({ bot, view, onRetry }: { bot: Bot; view: Exclude<ComputerView, "live">; onRetry: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const { mood, title, line, shimmer } = faces[view];
  const wake = () => {
    setError(null);
    window.chiefbot.bots.start(bot.id).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  };
  return (
    <div className="flex aspect-[16/10] flex-col items-center justify-center gap-3 rounded-lg border bg-muted/40 px-6 text-center">
      <Avatar avatar={bot.avatar} mood={mood} className="size-16" />
      <div className="flex flex-col gap-1">
        <p role="status" className={cn("font-medium text-sm", shimmer && "shimmer-text")}>
          {title}
        </p>
        <p className="text-muted-foreground text-xs">{line}</p>
      </div>
      {view === "asleep" && (
        <>
          <Button size="xs" variant="outline" onClick={wake}>
            <PowerIcon />
            Wake
          </Button>
          <ErrorText message={error} />
        </>
      )}
      {view === "unreachable" && (
        <Button size="xs" variant="outline" onClick={onRetry}>
          <RotateCwIcon />
          Try again
        </Button>
      )}
    </div>
  );
}

// noVNC on control's screen WebSocket. It reconnects 2 s after a drop and counts each attempt
// that never connected (`setFailures`), so the tab can say it cannot reach the computer.
// noVNC draws into a div React does not manage (`screen`): full screen moves that div into its
// dialog and back, so the connection stays open.
function LiveScreen({ bot, setFailures }: { bot: Bot; setFailures: Dispatch<SetStateAction<number>> }) {
  const [screen] = useState(() => {
    const element = document.createElement("div");
    element.style.cssText = "width: 100%; height: 100%";
    return element;
  });
  const client = useRef<RFB | null>(null);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [full, setFull] = useState(false);
  const interactive = bot.screenControl === "human";

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void window.chiefbot.bots.screenUrl(bot.id).then((url) => {
      if (cancelled) return;
      const rfb = new RFB(screen, url);
      rfb.scaleViewport = true;
      rfb.viewOnly = true;
      let opened = false;
      rfb.addEventListener("connect", () => {
        opened = true;
        setConnected(true);
        setFailures(0);
      });
      rfb.addEventListener("disconnect", () => {
        setConnected(false);
        if (cancelled) return;
        setFailures((count) => afterDisconnect(count, opened));
        retry = setTimeout(() => setAttempt((count) => count + 1), 2000);
      });
      client.current = rfb;
    });
    return () => {
      cancelled = true;
      clearTimeout(retry);
      client.current?.disconnect();
      client.current = null;
    };
  }, [bot.id, screen, setFailures, attempt]);

  // Input reaches the bot's computer only while the user has control.
  useEffect(() => {
    if (client.current) client.current.viewOnly = !interactive;
  }, [interactive, connected]);

  const frame = <ScreenFrame screen={screen} connected={connected} interactive={interactive} />;
  return (
    <>
      {full ? <div className="grid aspect-[16/10] place-items-center rounded-lg border border-dashed text-muted-foreground text-xs">Showing full screen</div> : frame}
      <div className="relative flex justify-center">
        <ControlPill bot={bot} />
        <Button
          size="icon-xs"
          variant="ghost"
          className="absolute end-0 top-1/2 -translate-y-1/2"
          aria-label="Full screen"
          title="Full screen"
          onClick={() => setFull(true)}
        >
          <Maximize2Icon />
        </Button>
      </div>
      {full && (
        <FullScreen bot={bot} onClose={() => setFull(false)}>
          {frame}
        </FullScreen>
      )}
    </>
  );
}

// 16:10 like the bot's 1280×800 screen, with a green ring while the user has control.
// Mounting it moves noVNC's div into it.
function ScreenFrame({ screen, connected, interactive }: { screen: HTMLDivElement; connected: boolean; interactive: boolean }) {
  return (
    <div className={cn("relative aspect-[16/10] overflow-hidden rounded-lg border bg-black", interactive && "border-success ring-2 ring-success/24")}>
      <div
        className="size-full"
        ref={(host) => {
          // Only on a move: re-adding it in place would take the keyboard away from the screen.
          if (host && screen.parentElement !== host) host.append(screen);
        }}
      />
      {!connected && (
        <p className="absolute inset-0 flex items-center justify-center gap-2 text-muted-foreground text-xs">
          <Spinner className="size-3.5" />
          Connecting to the screen…
        </p>
      )}
    </div>
  );
}

// The bot's screen filling the window, after Grok's: a top bar with the bot and Exit full screen,
// the screen as large as fits, and the control pill under it. A native modal <dialog> keeps focus
// inside and leaves on Escape, unless the user has control and the screen has focus: noVNC then
// takes the key for the bot's computer. Closing on unmount hands focus back to Full screen.
function FullScreen({ bot, onClose, children }: { bot: Bot; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={`${bot.name}'s screen`}
      className="m-0 size-full max-h-none max-w-none flex-col border-0 bg-background p-0 text-foreground outline-none [-webkit-app-region:no-drag] open:flex"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {/* After the window buttons on macOS, as the sidebar's controls are. */}
      <div className="drag-region flex h-(--topbar-height) shrink-0 items-center gap-2 border-b ps-(--sidebar-controls-left) pe-3">
        <Avatar avatar={bot.avatar} className="size-5" />
        <h2 className="min-w-0 truncate font-medium text-sm">{bot.name}</h2>
        <Button size="icon-xs" variant="ghost" className="ms-auto" aria-label="Exit full screen" title="Exit full screen (Esc)" onClick={onClose}>
          <Minimize2Icon />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-4 p-6 pb-8">
        {/* The largest 16:10 box that fits: as wide as the space, or 1.6 times its height. */}
        <div className="grid min-h-0 w-full flex-1 place-items-center [container-type:size]">
          <div className="w-[min(100cqw,160cqh)]">{children}</div>
        </div>
        <ControlPill bot={bot} />
      </div>
    </dialog>
  );
}

// Who drives the screen and the switch, after Grok's floating pill: "Watching | Take control"
// while the bot drives, "You're in control | Stop" while the user does (take-over, hand-back).
// A refused switch shows a short line under the pill, with control's reason on hover, until the next try
// or until who drives changes.
function ControlPill({ bot }: { bot: Bot }) {
  const { takeOver, handBack } = window.chiefbot.bots;
  const human = bot.screenControl === "human";
  const [error, setError] = useState<{ text: string; reason: string } | null>(null);
  // A switch made since (in the other pill, or by control) makes an old refusal stale:
  // one already shown goes, and one that comes back later is dropped (`switches`).
  const [control, setControl] = useState(bot.screenControl);
  if (control !== bot.screenControl) {
    setControl(bot.screenControl);
    setError(null);
  }
  const switches = useRef(0);
  useEffect(() => {
    switches.current += 1;
  }, [bot.screenControl]);
  const toggle = () => {
    setError(null);
    const text = human ? "Couldn't hand the screen back." : "Couldn't take control.";
    const at = switches.current;
    (human ? handBack : takeOver)(bot.id).catch((caught: unknown) => {
      if (switches.current === at) setError({ text, reason: caught instanceof Error ? caught.message : String(caught) });
    });
  };
  return (
    <div className="relative">
      <div role="group" aria-label="Screen control" className="dropdown-glass flex items-center gap-2 rounded-full py-1 ps-3 pe-1 text-xs shadow-lg/5">
        <span aria-live="polite" className="flex items-center gap-1.5 font-medium">
          {human ? <MousePointer2Icon className="size-3.5 text-success" /> : <EyeIcon className="size-3.5 text-muted-foreground" />}
          {human ? "You're in control" : "Watching"}
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
            disabled={bot.status !== "online"}
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
