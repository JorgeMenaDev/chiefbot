import type { Tool, ToolInvocation, ToolResultObject } from "@github/copilot-sdk";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// The computer's screen: Xvfb :1 at 1280×800 (infra/computer/start.sh).
// Screenshots are taken at that size, so a screenshot's pixel is the screen's.
const SCREEN = { width: 1280, height: 800 } as const;

const Point = z.object({
  x: z.number().int().min(0).max(SCREEN.width - 1),
  y: z.number().int().min(0).max(SCREEN.height - 1),
});

// Every xdotool command: `xdotool help` in the image (3.20160805.1), plus
// getwindowclassname, windowquit and windowstate from later versions. An
// argument of `xdotool key` that names one starts that command instead.
const xdotoolCommands: ReadonlySet<string> = new Set([
  "behave", "behave_screen_edge", "click", "exec", "get_desktop", "get_desktop_for_window", "get_desktop_viewport",
  "get_num_desktops", "getactivewindow", "getdisplaygeometry", "getmouselocation", "getwindowclassname",
  "getwindowfocus", "getwindowgeometry", "getwindowname", "getwindowpid", "help", "key", "keydown", "keyup",
  "mousedown", "mousemove", "mousemove_relative", "mouseup", "search", "selectwindow", "set_desktop",
  "set_desktop_for_window", "set_desktop_viewport", "set_num_desktops", "set_window", "sleep", "type", "version",
  "windowactivate", "windowclose", "windowfocus", "windowkill", "windowmap", "windowminimize", "windowmove",
  "windowquit", "windowraise", "windowreparent", "windowsize", "windowstate", "windowunmap",
]);

// One key or chord: X key names (modifiers such as ctrl, alt, shift and super
// are key names too) joined by +, so it is a single argument of `xdotool key`.
// No spaces, so nothing after it, and no part may name an xdotool command.
const keyName = /^([A-Za-z][A-Za-z0-9_]*|[0-9])$/;
const keyChord = "one key or chord of X key names joined by +, e.g. ctrl+l, Return, ctrl+shift+Tab, F5";
const Keys = z
  .string()
  .max(64)
  .refine((keys) => keys.split("+").every((part) => keyName.test(part) && !xdotoolCommands.has(part.toLowerCase())), keyChord)
  .describe(keyChord);

// The longest text one action types, and how much of it one xdotool command
// types: the person can take over between chunks.
const MAX_TEXT = 1000;
const TEXT_CHUNK = 100;

// One thing the bot does on its screen. A union, not a discriminated one: its
// JSON Schema is anyOf, which every model's tool schema takes (oneOf is not).
const ComputerAction = z.union([
  z.object({
    kind: z.literal("click"),
    at: Point,
    button: z.enum(["left", "right", "middle"]).optional(),
    count: z.literal([1, 2, 3]).optional(),
  }),
  z.object({ kind: z.literal("move"), at: Point }),
  z.object({ kind: z.literal("drag"), from: Point, to: Point }),
  z.object({
    kind: z.literal("scroll"),
    at: Point,
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(30).optional().describe("Wheel clicks. Default 5."),
  }),
  z.object({ kind: z.literal("type"), text: z.string().min(1).max(MAX_TEXT) }),
  z.object({ kind: z.literal("key"), keys: Keys }),
  z.object({ kind: z.literal("wait"), ms: z.number().int().min(0).max(5000) }),
  z.object({ kind: z.literal("screenshot") }),
]);
type ComputerAction = z.infer<typeof ComputerAction>;

const ComputerArgs = z.object({ actions: z.array(ComputerAction).min(1).max(10) });
type ComputerArgs = z.infer<typeof ComputerArgs>;

// Runs one command (argv) against the computer's display and resolves with its
// stdout, or throws with what went wrong. It stops the command when `signal`
// aborts. The tool's only seam: displayCommands() on the computer, fakeDisplay() in tests.
export type CommandRunner = (command: string[], signal?: AbortSignal) => Promise<Uint8Array>;

// The real CommandRunner, on the computer's screen (display :1). xdotool reads
// typed text in the locale's encoding, and the image sets no locale: UTF-8 lets
// it type non-ASCII text. A command fails when it exits non-zero or complains on
// stderr: xdotool only warns about an unknown key name, and exits 0. It is
// killed past `deadlineMs`, once stdout or stderr passes `maxOutput` bytes, or
// when `signal` aborts. Once it has exited, its output gets one more second to
// end: a child it left behind may hold it open.
export function displayCommands({ deadlineMs = 10_000, maxOutput = 1024 * 1024 } = {}): CommandRunner {
  return async (command, signal) => {
    const proc = Bun.spawn(command, {
      env: { ...process.env, DISPLAY: ":1", LC_ALL: "C.UTF-8" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: deadlineMs,
      maxBuffer: maxOutput,
      killSignal: "SIGKILL",
      ...(signal ? { signal } : {}),
    });
    const output = Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    const drained = await Promise.race([output, Bun.sleep(1000).then(() => null)]);
    if (signal?.aborted) throw new Error(`${command[0]} was cancelled`);
    if (proc.signalCode !== null || drained === null) throw new Error(`${command[0]} was stopped: over ${deadlineMs / 1000} s or ${maxOutput} bytes of output`);
    const [stdout, stderr] = drained;
    if (exitCode !== 0 || stderr.trim() !== "") throw new Error(stderr.trim() || `${command[0]} exited with ${exitCode}`);
    return stdout;
  };
}

export const computerToolName = "computer";

// The line every bot's and task worker's session gets in its system message, so it knows the screen is there.
export const computerInstructions = `You have your own Linux computer with a ${SCREEN.width}×${SCREEN.height} screen and Chromium. Use the \`${computerToolName}\` tool to see and operate it.`;

const buttons = { left: "1", middle: "2", right: "3" } as const;
const wheel = { up: "4", down: "5", left: "6", right: "7" } as const;

// The xdotool commands that do `action`: one, a text's chunks, or none for one that only looks.
function commandsFor(action: ComputerAction): string[][] {
  const at = (point: z.infer<typeof Point>) => [String(point.x), String(point.y)];
  switch (action.kind) {
    case "click":
      return [["xdotool", "mousemove", ...at(action.at), "click", "--repeat", String(action.count ?? 1), buttons[action.button ?? "left"]]];
    case "move":
      return [["xdotool", "mousemove", ...at(action.at)]];
    case "drag":
      return [["xdotool", "mousemove", ...at(action.from), "mousedown", "1", "sleep", "0.1", "mousemove", ...at(action.to), "sleep", "0.1", "mouseup", "1"]];
    case "scroll":
      return [["xdotool", "mousemove", ...at(action.at), "click", "--repeat", String(action.amount ?? 5), wheel[action.direction]]];
    case "type": {
      // By code point, so no character is split.
      const characters = Array.from(action.text);
      const chunks = Array.from({ length: Math.ceil(characters.length / TEXT_CHUNK) }, (_, i) => characters.slice(i * TEXT_CHUNK, (i + 1) * TEXT_CHUNK).join(""));
      return chunks.map((chunk) => ["xdotool", "type", "--", chunk]);
    }
    case "key":
      return [["xdotool", "key", action.keys]];
    case "wait":
      return [["xdotool", "sleep", String(action.ms / 1000)]];
    case "screenshot":
      return [];
  }
}

// A computer call's line in the chat: the tool and its action kinds in order
// ("computer: key, type, screenshot"), or just the tool when its args are invalid.
export function computerRow(args: unknown) {
  const parsed = ComputerArgs.safeParse(args);
  return parsed.success ? `${computerToolName}: ${parsed.data.actions.map(({ kind }) => kind).join(", ")}` : computerToolName;
}

// Where the pointer is, from `xdotool getmouselocation --shell` (X=…, Y=… lines).
const MouseLocation = z.object({ X: z.coerce.number().int(), Y: z.coerce.number().int() });
function cursorFrom(output: Uint8Array) {
  const { X, Y } = MouseLocation.parse(Object.fromEntries(new TextDecoder().decode(output).split("\n").map((line) => line.split("="))));
  return { x: X, y: Y };
}

// The mouse button `action` presses, to release if its command is cut short
// (a drag holds it down between its mousedown and mouseup).
function heldButton(action: ComputerAction) {
  switch (action.kind) {
    case "click":
      return buttons[action.button ?? "left"];
    case "drag":
      return "1";
    case "scroll":
      return wheel[action.direction];
    default:
      return null;
  }
}

// Runs `actions` in order through `run`, checking before each command that the
// agent has the screen. A command that fails or is cut short has its action's
// button released by `release`; then a call no longer wanted throws (`run`
// does, and so does `stopIfAbandoned`). How many actions went through, and why
// it stopped early.
async function act(
  actions: ComputerAction[],
  { run, release, agentHasScreen, stopIfAbandoned }: { run: (command: string[]) => Promise<unknown>; release: (button: string) => Promise<void>; agentHasScreen: () => boolean; stopIfAbandoned: () => void },
) {
  for (const [ran, action] of actions.entries()) {
    for (const command of commandsFor(action)) {
      if (!agentHasScreen()) return { ran, error: "the person has the screen" };
      try {
        await run(command);
      } catch (failure) {
        const button = heldButton(action);
        if (button) await release(button);
        stopIfAbandoned();
        return { ran, error: `${action.kind} failed: ${failure instanceof Error ? failure.message : String(failure)}` };
      }
    }
  }
  return { ran: actions.length };
}

// The bot's `computer` tool: it sees and operates its own screen through `run`.
// One call runs 1 to 10 actions in order and stops at the first that fails, or
// before the next command once `agentHasScreen` says the person took the screen
// over; `ran` says how many went through. Every call then settles for 300 ms
// and returns the cursor and one PNG screenshot. The screenshot goes only to
// the model: scrot writes it in `screenshotDir` (the turn's own temporary
// folder), and the tool reads and deletes it. Invalid actions throw before
// anything runs, so the model reads why. Every command gets a signal that
// aborts when the runtime cancels the call or `turnEnded` aborts: the command
// running stops, its button is released, and the call throws without running another.
export function computerTool({
  run,
  agentHasScreen,
  turnEnded,
  screenshotDir,
}: {
  run: CommandRunner;
  agentHasScreen: () => boolean;
  turnEnded: AbortSignal;
  screenshotDir: string;
}) {
  return {
    name: computerToolName,
    description:
      `See and operate your computer's ${SCREEN.width}×${SCREEN.height} screen, with Chromium open on it. Runs 1 to 10 actions in order and stops at the first that fails, ` +
      "then waits 300 ms and returns { ran, cursor, error? } with one screenshot. Coordinates are screenshot pixels. " +
      'To look, send only { kind: "screenshot" }. To open a page in Chromium: key ctrl+l, type the address, key Return, wait. ' +
      `A key action presses one key or chord; a type action types up to ${MAX_TEXT} characters.`,
    parameters: ComputerArgs,
    async handler(raw: unknown, invocation: ToolInvocation): Promise<ToolResultObject> {
      const parsed = ComputerArgs.safeParse(raw);
      if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
      const signal = invocation.signal ? AbortSignal.any([turnEnded, invocation.signal]) : turnEnded;
      const stopIfAbandoned = () => {
        if (turnEnded.aborted) throw new Error("This computer call's turn has ended.");
        if (signal.aborted) throw new Error("This computer call was cancelled.");
      };
      // Every command of the call, while it is still wanted: one stopped as it ends says why.
      const runHere = async (command: string[]) => {
        stopIfAbandoned();
        try {
          return await run(command, signal);
        } catch (failure) {
          stopIfAbandoned();
          throw failure;
        }
      };
      // On its own short deadline, as the call's signal may have aborted already. A failure leaves nothing more to do.
      const release = (button: string) => run(["xdotool", "mouseup", button], AbortSignal.timeout(2000)).then(() => undefined, () => undefined);
      const { ran, error } = await act(parsed.data.actions, { run: runHere, release, agentHasScreen, stopIfAbandoned });
      await runHere(["xdotool", "sleep", "0.3"]);
      const cursor = cursorFrom(await runHere(["xdotool", "getmouselocation", "--shell"]));
      const path = join(screenshotDir, `${crypto.randomUUID()}.png`);
      mkdirSync(screenshotDir, { recursive: true });
      let png: Buffer;
      try {
        await runHere(["scrot", "--overwrite", path]);
        png = readFileSync(path);
      } finally {
        rmSync(path, { force: true });
      }
      stopIfAbandoned();
      return {
        textResultForLlm: JSON.stringify({ ran, cursor, error }),
        binaryResultsForLlm: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
        resultType: "success",
      };
    },
  } satisfies Tool<ComputerArgs>;
}
