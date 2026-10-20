import { expect, test } from "bun:test";
import { followLatest } from "./followLatest.ts";

// Main as a hook sees it: its kept snapshot replies when `reply` is called, and `push` sends an update.
function main() {
  let push = (_next: string) => {};
  let reply = (_kept: string) => {};
  const subscribe = (listener: (next: string) => void) => {
    push = listener;
    return () => undefined;
  };
  const snapshot = () => new Promise<string>((resolve) => (reply = resolve));
  return { subscribe, snapshot, push: (next: string) => push(next), reply: (kept: string) => reply(kept) };
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
