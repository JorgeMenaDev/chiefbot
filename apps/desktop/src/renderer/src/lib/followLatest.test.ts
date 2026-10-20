import { expect, spyOn, test } from "bun:test";
import { followLatest } from "./followLatest.ts";

// Main as a hook sees it: its kept snapshot replies when `reply` is called, and `push` sends an update.
function main() {
  let push = (_next: string) => {};
  let reply = (_kept: string) => {};
  let refuse = (_error: Error) => {};
  const subscribe = (listener: (next: string) => void) => {
    push = listener;
    return () => undefined;
  };
  const snapshot = () =>
    new Promise<string>((resolve, reject) => {
      reply = resolve;
      refuse = reject;
    });
  return { subscribe, snapshot, push: (next: string) => push(next), reply: (kept: string) => reply(kept), refuse: (error: Error) => refuse(error) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("an update that comes before main's kept snapshot wins: the older snapshot never replaces it", async () => {
  const late = main();
  const seen: string[] = [];
  followLatest(late.subscribe, late.snapshot, (next) => seen.push(next));
  late.push("newer");
  late.reply("older");
  await tick();
  expect(seen).toEqual(["newer"]);

  const quiet = main();
  const kept: string[] = [];
  followLatest(quiet.subscribe, quiet.snapshot, (next) => kept.push(next));
  quiet.reply("kept");
  await tick();
  expect(kept).toEqual(["kept"]);
});

test("once unsubscribed, nothing reaches `set`: not main's snapshot, nor an update still on its way", async () => {
  const closed = main();
  const seen: string[] = [];
  const unsubscribe = followLatest(closed.subscribe, closed.snapshot, (next) => seen.push(next));
  unsubscribe();
  closed.reply("kept");
  closed.push("newer");
  await tick();
  expect(seen).toEqual([]);
});

test("a snapshot main cannot give is logged, and updates still apply", async () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const failing = main();
    const seen: string[] = [];
    followLatest(failing.subscribe, failing.snapshot, (next) => seen.push(next));
    failing.refuse(new Error("no handler for projects:tasks"));
    await tick();
    failing.push("newer");
    expect(seen).toEqual(["newer"]);
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
});
