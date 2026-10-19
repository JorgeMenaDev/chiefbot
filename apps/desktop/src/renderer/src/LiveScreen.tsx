import type { Bot } from "@chiefbot/contracts";
import RFB from "@novnc/novnc";
import { MonitorIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { cn } from "./lib/utils.ts";

// The bot's live screen, through control. The user watches until they take
// over; then mouse and keyboard go to the bot's computer and the agent waits.
export function ScreenPane({ bot }: { bot: Bot }) {
  const { takeOver, handBack } = window.chiefbot.bots;
  const human = bot.screenControl === "human";
  return (
    <aside className="flex w-[42%] min-w-[360px] shrink-0 flex-col border-l bg-card/40">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3">
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
          <MonitorIcon className="size-3.5 shrink-0" />
          <span className="truncate">{human ? "You have control. The bot waits." : "Watching. The bot drives."}</span>
        </span>
        {human ? (
          <Button size="xs" variant="outline" onClick={() => void handBack(bot.id)}>
            Hand back
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={() => void takeOver(bot.id)} disabled={bot.status !== "online"}>
            Take over
          </Button>
        )}
      </div>
      <div className="p-3">
        {bot.status === "online" ? (
          <LiveScreen key={bot.id} botId={bot.id} interactive={human} />
        ) : (
          <div className="grid aspect-[16/10] place-items-center rounded-lg border border-dashed text-muted-foreground text-xs">
            The screen shows when the bot is online.
          </div>
        )}
      </div>
    </aside>
  );
}

// noVNC on control's screen WebSocket. It reconnects after a drop, so a screen
// that is still starting shows up on its own.
function LiveScreen({ botId, interactive }: { botId: string; interactive: boolean }) {
  const target = useRef<HTMLDivElement>(null);
  const client = useRef<RFB | null>(null);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void window.chiefbot.bots.screenUrl(botId).then((url) => {
      if (cancelled) return;
      const rfb = new RFB(element, url);
      rfb.scaleViewport = true;
      rfb.viewOnly = true;
      rfb.addEventListener("connect", () => setConnected(true));
      rfb.addEventListener("disconnect", () => {
        setConnected(false);
        if (!cancelled) retry = setTimeout(() => setAttempt((count) => count + 1), 2000);
      });
      client.current = rfb;
    });
    return () => {
      cancelled = true;
      clearTimeout(retry);
      client.current?.disconnect();
      client.current = null;
    };
  }, [botId, attempt]);

  // Input reaches the bot's computer only while the user has control.
  useEffect(() => {
    if (client.current) client.current.viewOnly = !interactive;
  }, [interactive, connected]);

  return (
    // 16:10 like the bot's 1280×800 screen. A green ring while the user has control.
    <div className={cn("relative aspect-[16/10] overflow-hidden rounded-lg border bg-black", interactive && "border-success ring-2 ring-success/24")}>
      <div ref={target} className="size-full" />
      {!connected && (
        <p className="absolute inset-0 flex items-center justify-center gap-2 text-muted-foreground text-xs">
          <Spinner className="size-3.5" />
          Connecting to the screen…
        </p>
      )}
    </div>
  );
}
