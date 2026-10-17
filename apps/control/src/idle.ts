import type { BotId, UserId } from "@chiefbot/contracts";
import type { Clock } from "./clock.ts";

// How often control looks for idle bots.
export const IDLE_POLL_MS = 60_000;

// Stops each running bot's computer once it has been idle for `idleMs`: nothing
// busy (see `busy`) and no activity (`touch`) for that long. Busy is checked
// every minute; touch covers what happens in between, such as a short turn.
// Works the same for every ComputerProvider. Runs on control's clock.
export function startIdleStop({
  clock,
  idleMs,
  runningBots,
  busy,
  stop,
}: {
  clock: Clock;
  idleMs: number;
  // Every bot whose computer control wants running.
  runningBots: () => Array<{ userId: UserId; botId: BotId }>;
  // Whether the bot has work in hand right now.
  busy: (botId: BotId) => boolean;
  stop: (userId: UserId, botId: BotId) => Promise<void>;
}) {
  // When each running bot was last busy or active, or first seen running.
  const lastActive = new Map<BotId, number>();
  let cancel = () => {};

  function tick() {
    const now = clock.now();
    const running = runningBots();
    for (const botId of lastActive.keys()) {
      if (!running.some((bot) => bot.botId === botId)) lastActive.delete(botId);
    }
    for (const { userId, botId } of running) {
      const since = lastActive.get(botId);
      if (since === undefined || busy(botId)) lastActive.set(botId, now);
      else if (now - since >= idleMs) {
        lastActive.delete(botId);
        stop(userId, botId).catch((error) => console.error(`could not stop idle bot ${botId}`, error));
      }
    }
    cancel = clock.setTimeout(tick, IDLE_POLL_MS);
  }
  tick();

  return {
    // Something happened on the bot: its idle time starts again.
    touch: (botId: BotId) => void lastActive.set(botId, clock.now()),
    stop: () => cancel(),
  };
}
