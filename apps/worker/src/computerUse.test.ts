import { expect, test } from "bun:test";
import { computerTool } from "./computerUse.ts";
import { sdk } from "./fakeCopilot.ts";
import { fakeDisplay } from "./fakeDisplay.ts";
import { newTurnStream, toTurnEvents } from "./turnEvents.ts";

// A command in short: xdotool's subcommand, or the shell's script.
const step = (command: string[]) => (command[0] === "sh" ? command.slice(2).join(" ") : command.slice(0, 2).join(" "));

// The computer tool on a fake display, with the agent holding the screen unless `agentHasScreen` says otherwise.
function setup(agentHasScreen = () => true) {
  const display = fakeDisplay();
  const tool = computerTool({ run: display.run, agentHasScreen });
  return { display, call: (args: unknown) => tool.handler(args) };
}

test("a batch runs its actions in order as xdotool commands", async () => {
  const { display, call } = setup();

  await call({
    actions: [
      { kind: "click", at: { x: 10, y: 20 } },
      { kind: "click", at: { x: 30, y: 40 }, button: "right", count: 2 },
      { kind: "move", at: { x: 1, y: 2 } },
      { kind: "drag", from: { x: 5, y: 6 }, to: { x: 7, y: 8 } },
      { kind: "scroll", at: { x: 640, y: 400 }, direction: "down", amount: 3 },
      { kind: "type", text: "-hello" },
      { kind: "key", keys: "ctrl+l Return" },
      { kind: "wait", ms: 1500 },
      { kind: "screenshot" },
    ],
  });

  expect(display.commands.slice(0, 8)).toEqual([
    ["xdotool", "mousemove", "10", "20", "click", "--repeat", "1", "1"],
    ["xdotool", "mousemove", "30", "40", "click", "--repeat", "2", "3"],
    ["xdotool", "mousemove", "1", "2"],
    ["xdotool", "mousemove", "5", "6", "mousedown", "1", "sleep", "0.1", "mousemove", "7", "8", "sleep", "0.1", "mouseup", "1"],
    ["xdotool", "mousemove", "640", "400", "click", "--repeat", "3", "5"],
    ["xdotool", "type", "--", "-hello"],
    ["xdotool", "key", "ctrl+l", "Return"],
    ["xdotool", "sleep", "1.5"],
  ]);
});

test("every call ends with a settle, the cursor and one PNG screenshot for the model", async () => {
  const { display, call } = setup();
  display.cursor = { x: 12, y: 34 };

  const result = await call({ actions: [{ kind: "move", at: { x: 12, y: 34 } }, { kind: "screenshot" }] });

  expect(display.commands).toEqual([
    ["xdotool", "mousemove", "12", "34"],
    ["xdotool", "sleep", "0.3"],
    ["xdotool", "getmouselocation", "--shell"],
    ["sh", "-c", "scrot - | cat"],
  ]);
  expect(result).toEqual({
    textResultForLlm: JSON.stringify({ ran: 2, cursor: { x: 12, y: 34 } }),
    binaryResultsForLlm: [{ type: "image", mimeType: "image/png", data: Buffer.from(display.png).toString("base64") }],
    resultType: "success",
  });
});

test("a failed action stops the batch: ran says how many went through, and the screenshot still comes", async () => {
  const { display, call } = setup();
  display.fails = (command) => (command[1] === "key" ? "Invalid key sequence 'ctrl+nope'" : null);

  const result = await call({
    actions: [
      { kind: "click", at: { x: 10, y: 20 } },
      { kind: "key", keys: "ctrl+nope" },
      { kind: "type", text: "never typed" },
    ],
  });

  expect(display.commands.map(step)).toEqual([
    "xdotool mousemove",
    "xdotool key",
    "xdotool sleep",
    "xdotool getmouselocation",
    "scrot - | cat",
  ]);
  expect(JSON.parse(result.textResultForLlm)).toEqual({ ran: 1, cursor: display.cursor, error: "key failed: Invalid key sequence 'ctrl+nope'" });
  expect(result.binaryResultsForLlm).toHaveLength(1);
});

test("the person taking over mid-batch stops it before the next action", async () => {
  let agentHasScreen = true;
  const { display, call } = setup(() => agentHasScreen);
  // The person clicks Take over while the first click runs.
  display.hold = async (command) => {
    if (command[1] === "mousemove") agentHasScreen = false;
  };

  const result = await call({ actions: [{ kind: "click", at: { x: 10, y: 20 } }, { kind: "type", text: "not now" }] });

  expect(display.commands.map(step)).toEqual([
    "xdotool mousemove",
    "xdotool sleep",
    "xdotool getmouselocation",
    "scrot - | cat",
  ]);
  expect(JSON.parse(result.textResultForLlm)).toEqual({ ran: 1, cursor: display.cursor, error: "the person has the screen" });
});

const click = { kind: "click", at: { x: 1, y: 1 } };
test.each([
  ["no actions", []],
  ["more than 10 actions", Array.from({ length: 11 }, () => click)],
  ["a point off the 1280×800 screen", [{ kind: "click", at: { x: 1280, y: 10 } }]],
  ["a fractional point", [{ kind: "move", at: { x: 1.5, y: 10 } }]],
  ["a quadruple click", [{ ...click, count: 4 }]],
  ["a wait over 5 seconds", [{ kind: "wait", ms: 5001 }]],
  ["empty text", [{ kind: "type", text: "" }]],
  ["a key that is no xdotool key name", [{ kind: "key", keys: "--window 1 a" }]],
  ["an unknown kind", [{ kind: "launch", app: "xterm" }]],
])("%s is refused before anything runs", async (_name, actions) => {
  const { display, call } = setup();

  await expect(call({ actions })).rejects.toThrow();
  expect(display.commands).toEqual([]);
});

test("a computer call's chat row names its actions, and keeps them when it finishes", () => {
  const stream = newTurnStream();
  const actions = [{ kind: "key", keys: "ctrl+l" }, { kind: "type", text: "example.com" }, { kind: "key", keys: "Return" }, { kind: "screenshot" }];

  const started = toTurnEvents(sdk.toolStart("call-1", "computer", undefined, { actions }), stream);
  const finished = toTurnEvents(sdk.toolComplete("call-1", true), stream);

  expect([...started, ...finished]).toEqual([
    { type: "tool-call", toolCallId: "call-1", name: "computer: key, type, key, screenshot", status: "running" },
    { type: "tool-call", toolCallId: "call-1", name: "computer: key, type, key, screenshot", status: "succeeded" },
  ]);
});
