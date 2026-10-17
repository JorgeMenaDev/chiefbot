import type { Clock } from "./clock.ts";

// How often control looks for idle computers.
export const IDLE_POLL_MS = 60_000;

// Stops each running computer once it has been idle for `idleMs`: nothing busy
// (see `busy`) and no activity (`touch`) for that long. Busy is checked every
// minute; touch covers what happens in between, such as a short turn. Control
// runs one for bots and one for projects' coordinators. Works the same for
// every ComputerProvider. Runs on control's clock.
export function startIdleStop<Running extends { id: string }>({
  clock,
  idleMs,
  running,
  busy,
  stop,
}: {
  clock: Clock;
  idleMs: number;
  // Every computer control wants running, with what `stop` needs.
  running: () => Running[];
  // Whether its agent has work in hand right now.
  busy: (id: Running["id"]) => boolean;
  stop: (computer: Running) => Promise<void>;
}) {
  // When each running computer was last busy or active, or first seen running.
  const lastActive = new Map<Running["id"], number>();
  let cancel = () => {};

  function tick() {
    const now = clock.now();
    const computers = running();
    for (const id of lastActive.keys()) {
      if (!computers.some((computer) => computer.id === id)) lastActive.delete(id);
    }
    for (const computer of computers) {
      const since = lastActive.get(computer.id);
      if (since === undefined || busy(computer.id)) lastActive.set(computer.id, now);
      else if (now - since >= idleMs) {
        lastActive.delete(computer.id);
        stop(computer).catch((error) => console.error(`could not stop idle computer ${computer.id}`, error));
      }
    }
    cancel = clock.setTimeout(tick, IDLE_POLL_MS);
  }
  tick();

  return {
    // Something happened on the computer: its idle time starts again.
    touch: (id: Running["id"]) => void lastActive.set(id, clock.now()),
    stop: () => cancel(),
  };
}
