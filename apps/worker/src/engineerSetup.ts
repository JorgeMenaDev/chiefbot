import { instructionPaths, SETUP_LOG_MAX, type EngineerSetup, type SetupStep } from "@chiefbot/contracts";
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
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

// The most of one instruction file the agent is given.
const instructionMax = 64 * 1024;

// Sets an engineer's computer up for `setup`, before its agent starts: clones
// the repo into <workspace>/<repo name> (a verifier's then checks out the commit
// it checks, `setup.sha`, detached) and runs the setup command there with
// the project's secrets, each step reported as it starts and again as it ends,
// at `now` (epoch milliseconds). Its log is the end of its
// output with every secret hidden (secretRedactor.ts) as it streams, before it
// is cut to SETUP_LOG_MAX, so no cut leaves a piece of one. Then reads the
// repo's instruction files and finds its skill folders; a configured one the
// repo lacks is left out, and so is any that leads outside the clone or holds a
// link that does. A step that fails stops the setup: `failed` is that step,
// reported last.
export async function setUpEngineer({
  setup,
  workspace,
  shell,
  signal,
  report,
  now,
}: {
  setup: EngineerSetup;
  workspace: string;
  shell: SetupShell;
  signal: AbortSignal;
  report: (step: SetupStep) => void;
  now: () => number;
}): Promise<EngineerReady | { failed: SetupStep }> {
  const name = setup.repo.split("/")[1] ?? setup.repo;
  const clone = join(workspace, name);
  const secrets = secretRedactor(Object.values(setup.secrets));
  const run = async (step: SetupStep["step"], command: string, cwd: string, env: Record<string, string>) => {
    const output = secrets.stream();
    let log = "";
    const keep = (text: string) => (log = (log + text).slice(-SETUP_LOG_MAX));
    const startedAt = now();
    report({ step, command, exitCode: null, log, startedAt, endedAt: null });
    const exitCode = await shell(command, { cwd, env, signal, onOutput: (text) => keep(output.push(text)) });
    keep(output.end());
    const done = { step, command, exitCode, log, startedAt, endedAt: now() };
    report(done);
    return done;
  };

  const cloned = await run("clone", `git clone https://github.com/${setup.repo}.git ${name}`, workspace, {});
  if (cloned.exitCode !== 0) return { failed: cloned };
  if (setup.sha !== null) {
    const checkedOut = await run("checkout", `git fetch -q origin ${setup.sha} && git checkout -q --detach ${setup.sha}`, clone, {});
    if (checkedOut.exitCode !== 0) return { failed: checkedOut };
  }
  if (setup.command !== null) {
    const ran = await run("setup", setup.command, clone, setup.secrets);
    if (ran.exitCode !== 0) return { failed: ran };
  }

  // Where the clone really is: a file or folder counts only when it resolves
  // inside it, so no link (or a clone that is one) leads the agent elsewhere.
  const root = join(realpathSync(workspace), name);
  const files = instructionPaths(setup.instructions).flatMap((path) => {
    const real = within(root, join(clone, path));
    const text = real === null ? null : readFileStart(real, instructionMax);
    return text === null ? [] : [{ path, text }];
  });
  const skills = setup.skills.filter((path) => {
    const real = within(root, join(clone, path));
    return real !== null && isDirectory(real) && linksStayIn(root, real);
  });
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
    `You work in ${clone}, a clone of the GitHub repo ${setup.repo} ${setup.sha === null ? "on its default branch" : `at commit ${setup.sha}`}.` +
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

// The real path of `path`, links followed, when it is `root` or inside it; null
// when it is outside, or leads nowhere.
function within(root: string, path: string): string | null {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  return real === root || real.startsWith(root + sep) ? real : null;
}

// Whether every link anywhere in the folder `dir` leads inside `root`.
const linksStayIn = (root: string, dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).every((entry) => !entry.isSymbolicLink() || within(root, join(entry.parentPath, entry.name)) !== null);
