import { afterEach, expect, test } from "bun:test";
import { EngineerSetup, type SetupStep } from "@chiefbot/contracts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// What the clone makes: the repo's `files` and `links` (symbolic links, to their
// targets), by path. With `cloneTo`, the clone itself is a link to that folder.
type Repo = { files?: Record<string, string>; links?: Record<string, string>; cloneTo?: string };

// The real setup shell, except that the clone makes `repo` (no git, no network).
function cloning({ files = {}, links = {}, cloneTo }: Repo): SetupShell {
  const shell = setupShell({ PATH: process.env.PATH ?? "" });
  return async (command, options) => {
    if (!command.startsWith("git clone ")) return shell(command, options);
    const clone = join(options.cwd, "shop");
    if (cloneTo) symlinkSync(cloneTo, clone);
    else mkdirSync(clone);
    for (const path of [...Object.keys(files), ...Object.keys(links)]) mkdirSync(dirname(join(clone, path)), { recursive: true });
    for (const [path, text] of Object.entries(files)) writeFileSync(join(clone, path), text);
    for (const [path, target] of Object.entries(links)) symlinkSync(target, join(clone, path));
    return 0;
  };
}

async function setUp(command: string, secrets: Record<string, string>, repo: Repo = {}, config: { instructions?: string[]; skills?: string[] } = {}) {
  const steps: SetupStep[] = [];
  const ready = await setUpEngineer({
    setup: EngineerSetup.parse({ repo: "octo-org/shop", command, instructions: config.instructions ?? [], skills: config.skills ?? [], mcp: {}, secrets }),
    workspace: tempDir(),
    shell: cloning(repo),
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

test("an engineer reads no instruction file and loads no skill folder that leads outside its clone, while links inside it work", async () => {
  const outside = tempDir();
  writeFileSync(join(outside, "notes.md"), "Private notes.");
  mkdirSync(join(outside, "skills"));
  const repo = {
    files: { "docs/agents.md": "Prices are in cents.", "tools/skills/release/SKILL.md": "Release.", "kit/skills/lint/SKILL.md": "Lint.", "kit/style.md": "Tabs." },
    links: {
      "AGENTS.md": join(outside, "notes.md"),
      ".github/copilot-instructions.md": "../docs/agents.md",
      ".agents/skills": join(outside, "skills"),
      "tools/skills/release/notes.md": join(outside, "notes.md"),
      "kit/skills/lint/style.md": "../../style.md",
    },
  };

  const { ready } = await setUp("true", {}, repo, { instructions: ["docs/agents.md"], skills: [".agents/skills", "tools/skills", "kit/skills"] });

  expect("found" in ready ? ready.found : null).toEqual({ instructions: [".github/copilot-instructions.md", "docs/agents.md"], skills: ["kit/skills"] });
  expect("instructions" in ready ? ready.instructions : "").not.toContain("Private notes.");
});

test("a clone that is a link to a folder elsewhere gives its engineer no instruction file and no skill folder", async () => {
  const elsewhere = tempDir();
  writeFileSync(join(elsewhere, "AGENTS.md"), "Private notes.");
  mkdirSync(join(elsewhere, "skills"));

  const { ready } = await setUp("true", {}, { cloneTo: elsewhere }, { skills: ["skills"] });

  expect("found" in ready ? ready.found : null).toEqual({ instructions: [], skills: [] });
});
