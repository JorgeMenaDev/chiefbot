import { expect, test } from "bun:test";
import { BotId } from "./ids.ts";

test("BotId rejects an empty id", () => {
  expect(BotId.safeParse("").success).toBe(false);
  expect(BotId.safeParse("bot_1").success).toBe(true);
});
