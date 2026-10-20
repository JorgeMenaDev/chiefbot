import { expect, test } from "bun:test";
import { afterDisconnect, computerView } from "./computerView.ts";

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

test("a screen that connected and then dropped does not count as a failure; attempts that never connect do", () => {
  // Connected, dropped, then two reconnects that fail: still trying.
  let failures = afterDisconnect(0, true);
  failures = afterDisconnect(failures, false);
  failures = afterDisconnect(failures, false);
  expect(computerView("online", failures)).toBe("live");
  // The third attempt in a row that never connects gives up.
  failures = afterDisconnect(failures, false);
  expect(computerView("online", failures)).toBe("unreachable");
  // A drop after a good connection starts the count afresh.
  expect(afterDisconnect(2, true)).toBe(0);
});
