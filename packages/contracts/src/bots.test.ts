import { expect, test } from "bun:test";
import { CreateBotRequest } from "./bots.ts";

test("a bot asked for without a face gets the chief in blue", () => {
  expect(CreateBotRequest.parse({ name: "Ada" }).avatar).toEqual({ shape: "chief", color: "blue" });
  expect(CreateBotRequest.parse({ name: "Ada", avatar: { shape: "flower", color: "red" } }).avatar).toEqual({ shape: "flower", color: "red" });
});

test("a face or colour outside the set is refused", () => {
  expect(CreateBotRequest.safeParse({ name: "Ada", avatar: { shape: "dragon", color: "blue" } }).success).toBe(false);
  expect(CreateBotRequest.safeParse({ name: "Ada", avatar: { shape: "chief", color: "#ff0000" } }).success).toBe(false);
});
