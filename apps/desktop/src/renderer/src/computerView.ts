import type { BotStatus } from "@chiefbot/contracts";

// What the Computer tab shows (LiveScreen.tsx): the bot's screen, or its face with a line about its computer.
//   waking       the computer is starting
//   live         online: its screen, connecting or connected
//   unreachable  online, but its last 3 screen connections in a row never connected (Try again)
//   sleeping     the computer is stopping
//   asleep       the computer is stopped (Wake starts it)
export type ComputerView = "waking" | "live" | "unreachable" | "sleeping" | "asleep";

// `failures` counts the screen connections in a row that never connected.
export function computerView(status: BotStatus, failures: number): ComputerView {
  switch (status) {
    case "starting":
      return "waking";
    case "online":
      return failures >= 3 ? "unreachable" : "live";
    case "stopping":
      return "sleeping";
    case "stopped":
      return "asleep";
  }
}

// `failures` after a screen connection ends: one more if it never connected; none if it
// connected and then dropped, so a drop alone never makes the computer unreachable.
export function afterDisconnect(failures: number, connected: boolean): number {
  return connected ? 0 : failures + 1;
}
