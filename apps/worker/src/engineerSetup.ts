import { SETUP_LOG_MAX, type EngineerSetup, type SetupStep } from "@chiefbot/contracts";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { secretRedactor } from "./secretRedactor.ts";

// Runs one setup command of an engineer: `sh -c command` in `cwd`, with `env`
// added to the computer's environment (whose own variables win), killed when
// `signal` aborts. Its output, stdout and stderr together, goes to `onOutput` as
// it comes; it resolves with the exit code. setupShell (here) in a computer; a
// fake in tests.
export type SetupShell = (
  command: string,
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal; onOutput: (text: string) => void },
) => Promise<number>;

// The real setup shell: `sh` with `baseEnv`, the environment the agent's shell
// gets (no GitHub token; git sent to control's proxy: copilotSdk.ts). It reads
// nothing from stdin.
export function setupShell(baseEnv: Record<string, string | undefined>): SetupShell {
  return async (command, { cwd, env, signal, onOutput }) => {
    const proc = Bun.spawn(["sh", "-c", `exec 2>&1\n${command}`], { cwd, env: { ...env, ...baseEnv }, stdin: "ignore", stdout: "pipe", stderr: "ignore", signal });
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) onOutput(decoder.decode(chunk, { stream: true }));
    onOutput(decoder.decode());
    return proc.exited;
  };
}

// What an engineer's agent starts with once its setup is over: its clone (its
// working directory), the instructions its session gets, the repo's skill
// folders in the clone, and the repo paths of what was found.
export type EngineerReady = {
  clone: string;
  instructions: string;
  skillDirectories: string[];
  found: { instructions: string[]; skills: string[] };
};

// Instruction files every engineer reads when the repo has them, before the config's own.
const defaultInstructions = ["AGENTS.md", ".github/copilot-instructions.md"];
// The most of one instruction file the agent is given.
const instructionMax = 64 * 1024;

// Sets an engineer's computer up for `setup`, before its agent starts: clones
// the repo into <workspace>/<repo name> and runs the setup command there with
// the project's secrets, each step reported as it ends. Its log is the end of its
// output with every secret hidden (secretRedactor.ts) as it streams, before it
// is cut to SETUP_LOG_MAX, so no cut leaves a piece of one. Then reads the repo's instruction files and finds its skill
// folders; a configured one the repo lacks is left out. A step that fails stops
// the setup: `failed` is that step, reported last.
export async function setUpEngineer({
  setup,
  workspace,
  shell,
  signal,
  report,
}: {
  setup: EngineerSetup;
  workspace: string;
  shell: SetupShell;
  signal: AbortSignal;
  report: (step: SetupStep) => void;
}): Promise<EngineerReady | { failed: SetupStep }> {
  const name = setup.repo.split("/")[1] ?? setup.repo;
  const clone = join(workspace, name);
  const secrets = secretRedactor(Object.values(setup.secrets));
  const run = async (step: SetupStep["step"], command: string, cwd: string, env: Record<string, string>) => {
    const output = secrets.stream();
    let log = "";
    const keep = (text: string) => (log = (log + text).slice(-SETUP_LOG_MAX));
    const exitCode = await shell(command, { cwd, env, signal, onOutput: (text) => keep(output.push(text)) });
    keep(output.end());
    const done: SetupStep = { step, command, exitCode, log };
    report(done);
    return done;
  };

  const cloned = await run("clone", `git clone https://github.com/${setup.repo}.git ${name}`, workspace, {});
  if (cloned.exitCode !== 0) return { failed: cloned };
  if (setup.command !== null) {
    const ran = await run("setup", setup.command, clone, setup.secrets);
    if (ran.exitCode !== 0) return { failed: ran };
  }

  const files = [...new Set([...defaultInstructions, ...setup.instructions])].flatMap((path) => {
    const text = readFileStart(join(clone, path), instructionMax);
    return text === null ? [] : [{ path, text }];
  });
  const skills = setup.skills.filter((path) => isDirectory(join(clone, path)));
  return {
    clone,
    instructions: engineerInstructions(setup, clone, files),
    skillDirectories: skills.map((path) => join(clone, path)),
    found: { instructions: files.map(({ path }) => path), skills },
  };
}

// What an engineer's session is told about its setup, and the repo's instructions.
function engineerInstructions(setup: EngineerSetup, clone: string, files: Array<{ path: string; text: string }>) {
  const secretNames = Object.keys(setup.secrets);
  return [
    `You work in ${clone}, a clone of the GitHub repo ${setup.repo} on its default branch.` +
      (setup.command === null ? "" : ` Chiefbot ran its setup there before you started: \`${setup.command}\`.`),
    ...(secretNames.length === 0
      ? []
      : [`The project's secrets are in your environment for this task only: ${secretNames.join(", ")}. Never print them, commit them or put them in a pull request.`]),
    ...(files.length === 0 ? [] : ["The repo's instructions follow, one file each.", ...files.map(({ path, text }) => `<file path="${path}">\n${text}\n</file>`)]),
  ].join("\n\n");
}

// The first `max` bytes of the regular file at `path` as text, or null when there is none.
function readFileStart(path: string, max: number): string | null {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return null;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(max);
    return buffer.subarray(0, readSync(fd, buffer, 0, max, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const isDirectory = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
