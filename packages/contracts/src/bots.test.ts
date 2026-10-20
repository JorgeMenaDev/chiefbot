import { expect, test } from "bun:test";
import { ControlToWorker, CreateBotRequest } from "./bots.ts";

test("a bot asked for without a face gets the chief in blue", () => {
  expect(CreateBotRequest.parse({ name: "Ada" }).avatar).toEqual({ shape: "chief", color: "blue" });
  expect(CreateBotRequest.parse({ name: "Ada", avatar: { shape: "flower", color: "red" } }).avatar).toEqual({ shape: "flower", color: "red" });
});

test("a face or colour outside the set is refused", () => {
  expect(CreateBotRequest.safeParse({ name: "Ada", avatar: { shape: "dragon", color: "blue" } }).success).toBe(false);
  expect(CreateBotRequest.safeParse({ name: "Ada", avatar: { shape: "chief", color: "#ff0000" } }).success).toBe(false);
});

const runTurn = { type: "run-turn", turnId: "turn_1", turnKey: "key_1", text: "hi", model: "claude-sonnet-4.6" };

test("a run-turn carries the bot's reasoning effort, access mode and the message's files; one from an older control runs at the default effort on Auto", () => {
  const attachments = [{ id: "attachment_1", name: "screen.png", mimeType: "image/png", size: 7 }];
  expect(ControlToWorker.parse({ ...runTurn, effort: "high", access: "supervised", attachments })).toMatchObject({ effort: "high", access: "supervised", attachments });
  expect(ControlToWorker.parse(runTurn)).toMatchObject({ effort: null, access: "auto", connections: [], attachments: [] });
});

test("a run-turn with an effort or access mode outside the set is refused", () => {
  expect(ControlToWorker.safeParse({ ...runTurn, effort: "extreme" }).success).toBe(false);
  expect(ControlToWorker.safeParse({ ...runTurn, access: "yolo" }).success).toBe(false);
});
