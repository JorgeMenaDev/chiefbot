// A clock for control's schedulers and a worker's token renewals. Injected so
// tests run on a fake one.
export type Clock = {
  now(): number;
  // Calls fn once, ms from now. Returns the cancel.
  setTimeout(fn: () => void, ms: number): () => void;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

// A clock for tests that moves only when advance() is called. Timers due on
// the way fire in time order, each with now() at its due time.
export function fakeClock(start: number) {
  let time = start;
  const timers = new Set<{ at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => time,
    setTimeout(fn, ms) {
      const timer = { at: time + ms, fn };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
  };
  return {
    clock,
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const next = [...timers].filter(({ at }) => at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        time = next.at;
        next.fn();
      }
      time = end;
    },
  };
}
