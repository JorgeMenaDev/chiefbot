import { expect, test } from "bun:test";
import { computerView } from "./computerView.ts";

test("each bot status has its own Computer tab view", () => {
  expect(computerView("starting", 0)).toBe("waking");
  expect(computerView("online", 0)).toBe("live");
  expect(computerView("stopping", 0)).toBe("sleeping");
  expect(computerView("stopped", 0)).toBe("asleep");
});

test("an online bot's screen is unreachable after 3 connection attempts in a row fail", () => {
  expect(computerView("online", 2)).toBe("live");
  expect(computerView("online", 3)).toBe("unreachable");
  // Failed attempts only count while the bot is online.
  expect(computerView("starting", 3)).toBe("waking");
  expect(computerView("stopped", 3)).toBe("asleep");
});
