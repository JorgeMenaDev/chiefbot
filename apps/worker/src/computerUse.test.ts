import { expect, test } from "bun:test";
import { computerTool, displayCommands } from "./computerUse.ts";
import { sdk } from "./fakeCopilot.ts";
import { fakeDisplay } from "./fakeDisplay.ts";
import { newTurnStream, toTurnEvents } from "./turnEvents.ts";

// A command in short: xdotool's subcommand, or the shell's script.
const step = (command: string[]) => (command[0] === "sh" ? command.slice(2).join(" ") : command.slice(0, 2).join(" "));

// The computer tool on a fake display. The agent holds the screen and its turn
// runs unless `agentHasScreen` or `turnRunning` say otherwise; `signal` is the call's.
function setup({ agentHasScreen = (): boolean => true, turnRunning = (): boolean => true } = {}) {
  const display = fakeDisplay();
  const tool = computerTool({ run: display.run, agentHasScreen, turnRunning });
  const call = (args: unknown, signal?: AbortSignal) =>
    tool.handler(args, { sessionId: "bot_1", toolCallId: "call-1", toolName: "computer", arguments: args, ...(signal ? { signal } : {}) });
  return { display, call };
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
      { kind: "key", keys: "ctrl+shift+Page_Down" },
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
    ["xdotool", "key", "ctrl+shift+Page_Down"],
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
  const { display, call } = setup({ agentHasScreen: () => agentHasScreen });
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
  // Each would chain another xdotool command after `key`.
  ["exec in a key", [{ kind: "key", keys: "exec echo X" }]],
  ["mousemove in a key", [{ kind: "key", keys: "mousemove 321 432" }]],
  ["type in a key", [{ kind: "key", keys: "type hello" }]],
  ["key --window in a key", [{ kind: "key", keys: "key --window 1 a" }]],
  ["an xdotool command as a key, in any case", [{ kind: "key", keys: "EXEC" }]],
  ["an xdotool command in a chord", [{ kind: "key", keys: "ctrl+mousemove" }]],
  ["two key presses in one action", [{ kind: "key", keys: "ctrl+a BackSpace" }]],
  ["a chord over 64 characters", [{ kind: "key", keys: `${"ctrl+".repeat(13)}a` }]],
  ["text over 1000 characters", [{ kind: "type", text: "a".repeat(1001) }]],
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

test("real key names and chords pass as one xdotool key argument", async () => {
  const { display, call } = setup();
  const keys = ["ctrl+l", "Return", "ctrl+shift+Tab", "F5", "a", "1", "KP_Enter", "super"];

  await call({ actions: keys.map((key) => ({ kind: "key", keys: key })) });

  expect(display.commands.slice(0, keys.length)).toEqual(keys.map((key) => ["xdotool", "key", key]));
});

test("long text types in chunks of 100 characters, and a take-over between chunks stops it", async () => {
  let agentHasScreen = true;
  const { display, call } = setup({ agentHasScreen: () => agentHasScreen });
  display.hold = async () => {
    if (display.commands.length === 2) agentHasScreen = false;
  };

  const result = await call({ actions: [{ kind: "type", text: `${"a".repeat(100)}${"b".repeat(100)}${"c".repeat(50)}` }] });

  expect(display.commands.slice(0, 2)).toEqual([
    ["xdotool", "type", "--", "a".repeat(100)],
    ["xdotool", "type", "--", "b".repeat(100)],
  ]);
  expect(display.commands.map(step).slice(2)).toEqual(["xdotool sleep", "xdotool getmouselocation", "scrot - | cat"]);
  expect(JSON.parse(result.textResultForLlm)).toEqual({ ran: 0, cursor: display.cursor, error: "the person has the screen" });
});

test("a cancelled call stops the command it runs and runs no other", async () => {
  const cancel = new AbortController();
  const { display, call } = setup();
  let running: AbortSignal | undefined;
  display.hold = async (_command, signal) => {
    running = signal;
    cancel.abort();
  };

  const result = call({ actions: [{ kind: "click", at: { x: 10, y: 20 } }, { kind: "type", text: "too late" }] }, cancel.signal);

  await expect(result).rejects.toThrow("cancelled");
  expect(running?.aborted).toBe(true);
  expect(display.commands.map(step)).toEqual(["xdotool mousemove"]);
});

test("a call whose turn has ended runs no further command", async () => {
  let turnRunning = true;
  const { display, call } = setup({ turnRunning: () => turnRunning });
  display.hold = async () => {
    turnRunning = false;
  };

  await expect(call({ actions: [{ kind: "click", at: { x: 10, y: 20 } }, { kind: "type", text: "too late" }] })).rejects.toThrow("turn has ended");
  expect(display.commands.map(step)).toEqual(["xdotool mousemove"]);
});

test.each([
  ["runs past its deadline", { deadlineMs: 100 }, ["sleep", "5"]],
  ["prints past its output cap", { maxOutput: 1000 }, ["sh", "-c", "yes"]],
])("the real runner stops a command that %s", async (_name, limits, command) => {
  const started = performance.now();

  await expect(displayCommands(limits)(command)).rejects.toThrow("was stopped");
  expect(performance.now() - started).toBeLessThan(2000);
});

test("an invalid call tells the model what is wrong, in words", async () => {
  const { call } = setup();

  await expect(call({ actions: [{ kind: "key", keys: "exec echo X" }] })).rejects.toThrow("one key or chord of X key names joined by +");
});

test("the real runner stops a command when its call is cancelled, and fails one that complains on stderr", async () => {
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(), 50);

  await expect(displayCommands()(["sleep", "5"], cancel.signal)).rejects.toThrow("cancelled");
  await expect(displayCommands()(["sh", "-c", "echo No such key name >&2"])).rejects.toThrow("No such key name");
  expect(new TextDecoder().decode(await displayCommands()(["printf", "X=1"]))).toBe("X=1");
});
