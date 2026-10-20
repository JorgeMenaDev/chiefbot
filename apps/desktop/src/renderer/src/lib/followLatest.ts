// Follows what Electron main sends into `set` until the returned unsubscribe,
// starting from what main has kept (`snapshot`). Subscribing first means no
// update is missed while the snapshot comes, and the snapshot applies only if
// no update came before it: it may be older than that update. Once
// unsubscribed, nothing reaches `set`. A snapshot main cannot give is logged,
// and updates still apply.
export function followLatest<T>(subscribe: (listener: (next: T) => void) => () => void, snapshot: () => Promise<T>, set: (next: T) => void) {
  let updated = false;
  let closed = false;
  const unsubscribe = subscribe((next) => {
    if (closed) return;
    updated = true;
    set(next);
  });
  snapshot().then(
    (kept) => {
      if (!updated && !closed) set(kept);
    },
    (error: unknown) => console.error("could not read what Electron main kept", error),
  );
  return () => {
    closed = true;
    unsubscribe();
  };
}
