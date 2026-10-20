import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import { z } from "zod";

// The computer's screen: Xvfb :1 at 1280×800 (infra/computer/start.sh).
// Screenshots are taken at that size, so a screenshot's pixel is the screen's.
const SCREEN = { width: 1280, height: 800 } as const;

const Point = z.object({
  x: z.number().int().min(0).max(SCREEN.width - 1),
  y: z.number().int().min(0).max(SCREEN.height - 1),
});

const keyNames = "xdotool key names joined by +, a space between presses, e.g. ctrl+l, Return, ctrl+a BackSpace";

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
  z.object({ kind: z.literal("type"), text: z.string().min(1) }),
  z.object({
    kind: z.literal("key"),
    keys: z
      .string()
      .regex(/^\w+(\+\w+)*( \w+(\+\w+)*)*$/, keyNames)
      .describe(keyNames),
  }),
  z.object({ kind: z.literal("wait"), ms: z.number().int().min(0).max(5000) }),
  z.object({ kind: z.literal("screenshot") }),
]);
type ComputerAction = z.infer<typeof ComputerAction>;

const ComputerArgs = z.object({ actions: z.array(ComputerAction).min(1).max(10) });
type ComputerArgs = z.infer<typeof ComputerArgs>;

// Runs one command (argv) against the computer's display and resolves with its
// stdout, or throws with what went wrong. The tool's only seam: displayCommands
// on the computer, fakeDisplay() in tests.
export type CommandRunner = (command: string[]) => Promise<Uint8Array>;

// The real CommandRunner, on the computer's screen (display :1). xdotool reads
// typed text in the locale's encoding, and the image sets no locale: UTF-8 lets
// it type non-ASCII text. A command fails when it exits non-zero or complains on
// stderr: xdotool only warns about an unknown key name, and exits 0.
export const displayCommands: CommandRunner = async (command) => {
  const proc = Bun.spawn(command, { env: { ...process.env, DISPLAY: ":1", LC_ALL: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0 || stderr.trim() !== "") throw new Error(stderr.trim() || `${command[0]} exited with ${exitCode}`);
  return stdout;
};

export const computerToolName = "computer";

// The line every bot's and task worker's session gets in its system message, so it knows the screen is there.
export const computerInstructions = `You have your own Linux computer with a ${SCREEN.width}×${SCREEN.height} screen and Chromium. Use the \`${computerToolName}\` tool to see and operate it.`;

const buttons = { left: "1", middle: "2", right: "3" } as const;
const wheel = { up: "4", down: "5", left: "6", right: "7" } as const;

// The xdotool command that does `action`, or null for one that only looks.
function commandFor(action: ComputerAction): string[] | null {
  const at = (point: z.infer<typeof Point>) => [String(point.x), String(point.y)];
  switch (action.kind) {
    case "click":
      return ["xdotool", "mousemove", ...at(action.at), "click", "--repeat", String(action.count ?? 1), buttons[action.button ?? "left"]];
    case "move":
      return ["xdotool", "mousemove", ...at(action.at)];
    case "drag":
      return ["xdotool", "mousemove", ...at(action.from), "mousedown", "1", "sleep", "0.1", "mousemove", ...at(action.to), "sleep", "0.1", "mouseup", "1"];
    case "scroll":
      return ["xdotool", "mousemove", ...at(action.at), "click", "--repeat", String(action.amount ?? 5), wheel[action.direction]];
    case "type":
      return ["xdotool", "type", "--", action.text];
    case "key":
      return ["xdotool", "key", ...action.keys.split(" ")];
    case "wait":
      return ["xdotool", "sleep", String(action.ms / 1000)];
    case "screenshot":
      return null;
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

// The bot's `computer` tool: it sees and operates its own screen through `run`.
// One call runs 1 to 10 actions in order and stops at the first that fails, or
// before the next one once `agentHasScreen` says the person took the screen
// over; `ran` says how many went through. Every call then settles for 300 ms
// and returns the cursor and one PNG screenshot. The screenshot goes only to
// the model: never to a file or to control. Invalid actions throw before
// anything runs, so the model reads why.
export function computerTool({ run, agentHasScreen }: { run: CommandRunner; agentHasScreen: () => boolean }) {
  return {
    name: computerToolName,
    description:
      `See and operate your computer's ${SCREEN.width}×${SCREEN.height} screen, with Chromium open on it. Runs 1 to 10 actions in order and stops at the first that fails, ` +
      "then waits 300 ms and returns { ran, cursor, error? } with one screenshot. Coordinates are screenshot pixels. " +
      'To look, send only { kind: "screenshot" }. To open a page in Chromium: key ctrl+l, type the address, key Return, wait.',
    parameters: ComputerArgs,
    async handler(raw: unknown): Promise<ToolResultObject> {
      const { actions } = ComputerArgs.parse(raw);
      let ran = 0;
      let error: string | undefined;
      for (const action of actions) {
        if (!agentHasScreen()) {
          error = "the person has the screen";
          break;
        }
        const command = commandFor(action);
        try {
          if (command) await run(command);
        } catch (failure) {
          error = `${action.kind} failed: ${failure instanceof Error ? failure.message : String(failure)}`;
          break;
        }
        ran++;
      }
      await run(["xdotool", "sleep", "0.3"]);
      const cursor = cursorFrom(await run(["xdotool", "getmouselocation", "--shell"]));
      // scrot writes "-" by opening /dev/stdout, which a socket (Bun's pipe to a child) refuses: a shell pipe is a real one.
      const png = await run(["sh", "-c", "scrot - | cat"]);
      return {
        textResultForLlm: JSON.stringify({ ran, cursor, error }),
        binaryResultsForLlm: [{ type: "image", mimeType: "image/png", data: Buffer.from(png).toString("base64") }],
        resultType: "success",
      };
    },
  } satisfies Tool<ComputerArgs>;
}
