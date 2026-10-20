// Follows what Electron main sends into `set` until the returned unsubscribe,
// starting from what main has kept (`snapshot`). Subscribing first means no
// update is missed while the snapshot comes, and the snapshot applies only if
// no update came before it: it may be older than that update.
export function followLatest<T>(subscribe: (listener: (next: T) => void) => () => void, snapshot: () => Promise<T>, set: (next: T) => void) {
  let updated = false;
  const unsubscribe = subscribe((next) => {
    updated = true;
    set(next);
  });
  void snapshot().then((kept) => {
    if (!updated) set(kept);
  });
  return unsubscribe;
}
