import type { CommandRunner } from "./computerUse.ts";

// A fake display for tests of the computer tool (computerUse.ts): its `run`
// records every command the tool runs and answers as xdotool and scrot would,
// with the pointer at `cursor` and the screen showing `png`. Waits (xdotool
// sleep) are instant. A test sets `fails` to make a command fail, and `hold` to
// hold the batch at a command.
export function fakeDisplay() {
  const display = {
    // Every command started, in order.
    commands: [] as string[][],
    cursor: { x: 640, y: 400 },
    png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    // The error a command fails with, or null when it succeeds.
    fails: (_command: string[]): string | null => null,
    // Awaited once a command starts.
    hold: async (_command: string[]): Promise<void> => {},
  };
  const run: CommandRunner = async (command) => {
    display.commands.push(command);
    await display.hold(command);
    const error = display.fails(command);
    if (error !== null) throw new Error(error);
    if (command.join(" ").includes("scrot")) return display.png;
    if (command[1] === "getmouselocation") return new TextEncoder().encode(`X=${display.cursor.x}\nY=${display.cursor.y}\nSCREEN=0\nWINDOW=2097156\n`);
    return new Uint8Array();
  };
  return Object.assign(display, { run });
}
