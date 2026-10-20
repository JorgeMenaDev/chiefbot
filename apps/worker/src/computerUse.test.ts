import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerTool, displayCommands } from "./computerUse.ts";
import { sdk } from "./fakeCopilot.ts";
import { fakeDisplay } from "./fakeDisplay.ts";
import { newTurnStream, toTurnEvents } from "./turnEvents.ts";

// A command in short: the program and its first argument.
const step = (command: string[]) => command.slice(0, 2).join(" ");

// The computer tool on a fake display, saving screenshots in a new temporary
// folder. The agent holds the screen unless `agentHasScreen` says otherwise;
// `endTurn()` ends its turn, and `signal` is the call's.
function setup({ agentHasScreen = (): boolean => true } = {}) {
  const display = fakeDisplay();
  const turn = new AbortController();
  const screenshotDir = join(mkdtempSync(join(tmpdir(), "chiefbot-screen-")), "screen");
  const tool = computerTool({ run: display.run, agentHasScreen, turnEnded: turn.signal, screenshotDir });
  const call = (args: unknown, signal?: AbortSignal) =>
    tool.handler(args, { sessionId: "bot_1", toolCallId: "call-1", toolName: "computer", arguments: args, ...(signal ? { signal } : {}) });
  return { display, call, endTurn: () => turn.abort(), screenshotDir };
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

test("every call ends with a settle, the cursor and one PNG screenshot for the model, deleted from disk", async () => {
  const { display, call, screenshotDir } = setup();
  display.cursor = { x: 12, y: 34 };

  const result = await call({ actions: [{ kind: "move", at: { x: 12, y: 34 } }, { kind: "screenshot" }] });

  expect(display.commands).toEqual([
    ["xdotool", "mousemove", "12", "34"],
    ["xdotool", "sleep", "0.3"],
    ["xdotool", "getmouselocation", "--shell"],
    ["scrot", "--overwrite", expect.stringMatching(new RegExp(`^${screenshotDir}/[\\w-]+\\.png$`))],
  ]);
  expect(readdirSync(screenshotDir)).toEqual([]);
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
    "xdotool keyup",
    "xdotool sleep",
    "xdotool getmouselocation",
    "scrot --overwrite",
  ]);
  expect(display.commands[2]).toEqual(["xdotool", "keyup", "--delay", "0", "ctrl", "nope"]);
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
    "scrot --overwrite",
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
  // Control characters other than newline and tab: their keys could stay held.
  ["a carriage return in text", [{ kind: "type", text: "a\rb" }]],
  ["a backspace in text", [{ kind: "type", text: "ab\b" }]],
  ["a NUL in text", [{ kind: "type", text: "\u0000" }]],
  ["a DEL in text", [{ kind: "type", text: "a\u007f" }]],
  ["a C1 control character in text", [{ kind: "type", text: "a\u0085" }]],
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
  expect(display.commands.map(step).slice(2)).toEqual(["xdotool sleep", "xdotool getmouselocation", "scrot --overwrite"]);
  expect(JSON.parse(result.textResultForLlm)).toEqual({ ran: 0, cursor: display.cursor, error: "the person has the screen" });
});

test("a cancelled call stops the command it runs and runs no other", async () => {
  const cancel = new AbortController();
  const { display, call } = setup();
  let running: AbortSignal | undefined;
  display.hold = async (_command, signal) => {
    running ??= signal;
    cancel.abort();
  };

  const result = call({ actions: [{ kind: "click", at: { x: 10, y: 20 } }, { kind: "type", text: "too late" }] }, cancel.signal);

  await expect(result).rejects.toThrow("cancelled");
  expect(running?.aborted).toBe(true);
  // The click's button is released: the one command after it.
  expect(display.commands.map(step)).toEqual(["xdotool mousemove", "xdotool mouseup"]);
});

test("ending the turn stops the command it runs, even the final settle, and runs no other", async () => {
  const { display, call, endTurn } = setup();
  const running: Array<AbortSignal | undefined> = [];
  display.hold = async (command, signal) => {
    running.push(signal);
    if (command[1] === "sleep") endTurn();
  };

  await expect(call({ actions: [{ kind: "type", text: "typed" }] })).rejects.toThrow("turn has ended");
  expect(display.commands.map(step)).toEqual(["xdotool type", "xdotool sleep"]);
  expect(running.every((signal) => signal?.aborted)).toBe(true);
});

test("a drag cut short releases its button with a command of its own, then the call goes on or stops", async () => {
  const { display, call } = setup();
  const drag = { kind: "drag", from: { x: 5, y: 6 }, to: { x: 7, y: 8 } };
  display.fails = (command) => (command.includes("mousedown") ? "the X server went away" : null);
  let release: AbortSignal | undefined;
  display.hold = async (command, signal) => {
    if (command[1] === "mouseup") release = signal;
  };

  const failed = await call({ actions: [drag] });

  expect(display.commands.map(step).slice(0, 2)).toEqual(["xdotool mousemove", "xdotool mouseup"]);
  expect(display.commands[1]).toEqual(["xdotool", "mouseup", "1"]);
  expect(release?.aborted).toBe(false);
  expect(JSON.parse(failed.textResultForLlm)).toMatchObject({ ran: 0, error: "drag failed: the X server went away" });

  const cancel = new AbortController();
  display.commands.length = 0;
  display.fails = () => null;
  display.hold = async (command) => {
    if (command.includes("mousedown")) cancel.abort();
  };
  await expect(call({ actions: [drag] }, cancel.signal)).rejects.toThrow("cancelled");
  expect(display.commands.map(step)).toEqual(["xdotool mousemove", "xdotool mouseup"]);
});

test.each([
  ["runs past its deadline", { deadlineMs: 100 }, ["sleep", "5"]],
  ["prints past its output cap", { maxOutput: 1000 }, ["yes"]],
  // A child of a killed command may hold its output open: it is not waited for.
  ["leaves a child holding its output", { deadlineMs: 100 }, ["sh", "-c", "sleep 3 | cat"]],
])("the real runner stops a command that %s", async (_name, limits, command) => {
  const started = performance.now();

  await expect(displayCommands(limits)(command)).rejects.toThrow("was stopped");
  expect(performance.now() - started).toBeLessThan(2000);
});

test("an invalid call tells the model what is wrong, in words", async () => {
  const { call } = setup();

  await expect(call({ actions: [{ kind: "key", keys: "exec echo X" }] })).rejects.toThrow("one key or chord of X key names joined by +");
  await expect(call({ actions: [{ kind: "type", text: "a\rb" }] })).rejects.toThrow("printable characters, newlines and tabs");
});

test("the real runner stops a command when its call is cancelled, and fails one that complains on stderr", async () => {
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(), 50);

  await expect(displayCommands()(["sleep", "5"], cancel.signal)).rejects.toThrow("cancelled");
  await expect(displayCommands()(["sh", "-c", "echo No such key name >&2"])).rejects.toThrow("No such key name");
  expect(new TextDecoder().decode(await displayCommands()(["printf", "X=1"]))).toBe("X=1");
});

test("a key cut short releases every part of its chord with a command of its own", async () => {
  const { display, call, endTurn } = setup();
  let release: AbortSignal | undefined;
  display.hold = async (command, signal) => {
    if (command[1] === "key") endTurn();
    if (command[1] === "keyup") release = signal;
  };

  await expect(call({ actions: [{ kind: "key", keys: "ctrl+shift+Tab" }, { kind: "key", keys: "Return" }] })).rejects.toThrow("turn has ended");

  expect(display.commands).toEqual([
    ["xdotool", "key", "ctrl+shift+Tab"],
    ["xdotool", "keyup", "--delay", "0", "ctrl", "shift", "Tab"],
  ]);
  expect(release?.aborted).toBe(false);
});

test("typing cut short releases the modifiers xdotool adds and every character of the chunk it was typing", async () => {
  const cancel = new AbortController();
  const { display, call } = setup();
  display.hold = async (command) => {
    if (command[3]?.startsWith("Ab")) cancel.abort();
  };

  const text = `${"a".repeat(100)}AbA b\n\té😀`;
  await expect(call({ actions: [{ kind: "type", text }] }, cancel.signal)).rejects.toThrow("cancelled");

  expect(display.commands.map(step)).toEqual(["xdotool type", "xdotool type", "xdotool keyup"]);
  expect(display.commands[2]).toEqual([
    "xdotool", "keyup", "--delay", "0",
    "Shift_L", "Shift_R", "Control_L", "Alt_L", "Super_L", "ISO_Level3_Shift",
    // A, b, space, newline, tab, é, 😀: the X key names xdotool may type them with.
    "U0041", "U0062", "U0020", "Linefeed", "Return", "Tab", "U00E9", "U1F600",
  ]);
});
