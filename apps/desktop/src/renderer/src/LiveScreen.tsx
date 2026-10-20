import type { Bot } from "@chiefbot/contracts";
import RFB from "@novnc/novnc";
import { Maximize2Icon, Minimize2Icon, PowerIcon, RotateCwIcon } from "lucide-react";
import { useContext, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Avatar, type AvatarMood } from "./Avatar.tsx";
import { ErrorText, PaneShown } from "./Pane.tsx";
import { Button } from "./components/ui/button.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { afterDisconnect, computerView, type ComputerView } from "./computerView.ts";
import { botScreen, ControlPill, type ScreenTarget } from "./screenTargets.tsx";
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
  const target = botScreen(bot);
  return (
    <div className="flex flex-col gap-3 border-t px-5 py-4">
      {view === "live" ? (
        <LiveScreen key={bot.id} target={target} setFailures={setFailures} />
      ) : (
        <>
          <ComputerFace bot={bot} view={view} onRetry={() => setFailures(0)} />
          {/* The user can always hand the screen back, even while the bot is offline. */}
          {bot.screenControl === "human" && <ControlPill target={target} />}
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
// that never connected (`setFailures`), so the caller can say it cannot reach the computer.
// noVNC draws into a div React does not manage (`screen`): full screen moves that div into its
// dialog and back, so the connection stays open.
export function LiveScreen({ target, setFailures }: { target: ScreenTarget; setFailures: Dispatch<SetStateAction<number>> }) {
  const [screen] = useState(() => {
    const element = document.createElement("div");
    element.style.cssText = "width: 100%; height: 100%";
    return element;
  });
  const client = useRef<RFB | null>(null);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [full, setFull] = useState(false);
  // Its pane hidden (another tab), full screen closes in the same render: a modal
  // dialog in a hidden pane would block the whole window.
  const shown = useContext(PaneShown);
  if (full && !shown) setFull(false);
  const interactive = target.control === "human";
  // The target's calls as they are now: a new render of the same computer must not reconnect.
  const screenUrl = useRef(target.url);
  screenUrl.current = target.url;

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void screenUrl.current().then((url) => {
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
  }, [target.id, screen, setFailures, attempt]);

  // Input reaches the bot's computer only while the user has control.
  useEffect(() => {
    if (client.current) client.current.viewOnly = !interactive;
  }, [interactive, connected]);

  const frame = <ScreenFrame screen={screen} connected={connected} interactive={interactive} />;
  return (
    <>
      {full ? <div className="grid aspect-[16/10] place-items-center rounded-lg border border-dashed text-muted-foreground text-xs">Showing full screen</div> : frame}
      <div className="relative flex justify-center">
        <ControlPill target={target} />
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
        <FullScreen target={target} onClose={() => setFull(false)}>
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

// The screen filling the window, after Grok's: a top bar with its owner and Exit full screen,
// the screen as large as fits, and the control pill under it. A native modal <dialog> keeps focus
// inside and leaves on Escape, unless the user has control and the screen has focus: noVNC then
// takes the key for the computer. Closing on unmount hands focus back to Full screen.
function FullScreen({ target, onClose, children }: { target: ScreenTarget; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={`${target.name}'s screen`}
      className="m-0 size-full max-h-none max-w-none flex-col border-0 bg-background p-0 text-foreground outline-none [-webkit-app-region:no-drag] open:flex"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {/* After the window buttons on macOS, as the sidebar's controls are. */}
      <div className="drag-region flex h-(--topbar-height) shrink-0 items-center gap-2 border-b ps-(--sidebar-controls-left) pe-3">
        {target.face}
        <h2 className="min-w-0 truncate font-medium text-sm">{target.name}</h2>
        <Button size="icon-xs" variant="ghost" className="ms-auto" aria-label="Exit full screen" title="Exit full screen (Esc)" onClick={onClose}>
          <Minimize2Icon />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-4 p-6 pb-8">
        {/* The largest 16:10 box that fits: as wide as the space, or 1.6 times its height. */}
        <div className="grid min-h-0 w-full flex-1 place-items-center [container-type:size]">
          <div className="w-[min(100cqw,160cqh)]">{children}</div>
        </div>
        <ControlPill target={target} />
      </div>
    </dialog>
  );
}
