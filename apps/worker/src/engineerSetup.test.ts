import { afterEach, expect, test } from "bun:test";
import { EngineerSetup, type SetupStep } from "@chiefbot/contracts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setUpEngineer, setupShell, type SetupShell } from "./engineerSetup.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "chiefbot-engineer-"));
  made.push(dir);
  return dir;
};

// The real setup shell, except that the clone makes the repo from `files` (no git, no network).
function cloning(files: Record<string, string>): SetupShell {
  const shell = setupShell({ PATH: process.env.PATH ?? "" });
  return async (command, options) => {
    if (!command.startsWith("git clone ")) return shell(command, options);
    mkdirSync(join(options.cwd, "shop"));
    for (const [path, text] of Object.entries(files)) {
      const file = join(options.cwd, "shop", path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return 0;
  };
}

async function setUp(command: string, secrets: Record<string, string>, files: Record<string, string> = {}) {
  const steps: SetupStep[] = [];
  const ready = await setUpEngineer({
    setup: EngineerSetup.parse({ repo: "octo-org/shop", command, instructions: [], skills: [], mcp: {}, secrets }),
    workspace: tempDir(),
    shell: cloning(files),
    signal: new AbortController().signal,
    report: (step) => steps.push(step),
  });
  return { ready, steps };
}

test("a setup log hides each secret before it is cut to its last 16 KB, also one printed ten times and in base64", async () => {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(5000))).toString("hex");
  const print = `for i in 1 2 3 4 5 6 7 8 9 10; do printf '%s\\n' "$API_KEY"; done; printf %s "$API_KEY" | base64 | tr -d '\\n'; echo`;

  const { steps } = await setUp(print, { API_KEY: secret });

  expect(steps.at(-1)).toEqual({ step: "setup", command: print, exitCode: 0, log: "***\n".repeat(11) });
});
