import type { Bot } from "@chiefbot/contracts";
import RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "react";

// The bot's live screen, through control. The user watches until they take
// over; then mouse and keyboard go to the bot's computer and the agent waits.
export function ScreenPane({ bot }: { bot: Bot }) {
  const { takeOver, handBack } = window.chiefbot.bots;
  const human = bot.screenControl === "human";
  return (
    <aside className="screen-pane">
      <header className="screen-header">
        <span className="muted">{human ? "You have control. The bot waits." : "Watching. The bot drives."}</span>
        {human ? (
          <button onClick={() => void handBack(bot.id)}>Hand back</button>
        ) : (
          <button onClick={() => void takeOver(bot.id)} disabled={bot.status !== "online"}>
            Take over
          </button>
        )}
      </header>
      {bot.status === "online" ? (
        <LiveScreen key={bot.id} botId={bot.id} interactive={human} />
      ) : (
        <div className="screen-view screen-empty muted">The screen shows when the bot is online.</div>
      )}
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
    <div className={interactive ? "screen-view interactive" : "screen-view"}>
      <div ref={target} className="screen-canvas" />
      {!connected && <p className="screen-overlay muted">Connecting to the screen…</p>}
    </div>
  );
}
