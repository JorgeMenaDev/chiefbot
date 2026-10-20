// Runs the jobs of each key (a person, a project) one after another, in the
// order they came; another key's do not wait. A job that fails does not stop the next.
export function queue<Key>() {
  const last = new Map<Key, Promise<void>>();
  return <T>(key: Key, job: () => Promise<T>): Promise<T> => {
    const run = (last.get(key) ?? Promise.resolve()).then(job);
    const settled = run.then(
      () => {},
      () => {},
    );
    last.set(key, settled);
    void settled.then(() => {
      if (last.get(key) === settled) last.delete(key);
    });
    return run;
  };
}
