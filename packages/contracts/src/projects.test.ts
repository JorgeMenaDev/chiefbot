import { expect, test } from "bun:test";
import { effectiveConfig, ProjectFile } from "./projects.ts";

test("a project file takes every key, each optional, and refuses unknown ones", () => {
  const full = {
    instructions: ["docs/agents.md"],
    commands: { setup: "bun install", build: "bun run build", test: "bun test", dev: "bun run dev", devUrl: "http://localhost:3000" },
    skills: [".agents/skills/"],
    verify: "verify-app",
    connectors: ["github"],
    mcp: { playwright: { command: "npx", args: ["-y", "@playwright/mcp"] } },
    secrets: ["CLERK_PUBLISHABLE_KEY"],
    workers: { max: 3 },
  };
  expect(ProjectFile.parse(full)).toEqual(full);
  expect(ProjectFile.parse({})).toEqual({});

  for (const wrong of [
    { conectors: ["github"] },
    { commands: { install: "bun install" } },
    { commands: { devUrl: "localhost:3000" } },
    { skills: ["../outside"] },
    { instructions: ["/etc/passwd"] },
    { secrets: ["NOT A NAME"] },
    { mcp: { playwright: { command: "npx", url: "https://example.com" } } },
    { workers: { max: 0 } },
    // As YAML and JSON parse it: an own key, which a record would drop without a word.
    { mcp: JSON.parse('{"__proto__": {"command": "npx"}}') },
  ]) {
    expect(ProjectFile.safeParse(wrong).success).toBe(false);
  }
});

test("settings fill in or override the file key by key, and each key names where it comes from", () => {
  const file = ProjectFile.parse({
    connectors: ["github"],
    commands: { build: "bun run build", test: "bun test" },
    skills: [".agents/skills"],
    workers: { max: 3 },
  });
  const settings = ProjectFile.parse({ commands: { setup: "bun install", test: "bun run test:unit" }, connectors: [], secrets: ["API_KEY"] });

  expect(effectiveConfig(file, settings)).toEqual({
    config: {
      instructions: [],
      commands: { setup: "bun install", build: "bun run build", test: "bun run test:unit" },
      skills: [".agents/skills"],
      connectors: [],
      mcp: {},
      secrets: ["API_KEY"],
      workers: { max: 3 },
    },
    sources: {
      "commands.setup": "settings",
      "commands.build": "file",
      "commands.test": "settings",
      skills: "file",
      connectors: "settings",
      secrets: "settings",
      "workers.max": "file",
    },
  });
});

test("with no project file, the settings and the defaults make the config", () => {
  expect(effectiveConfig(null, {})).toEqual({
    config: { instructions: [], commands: {}, skills: [], connectors: [], mcp: {}, secrets: [], workers: { max: 2 } },
    sources: {},
  });
  expect(effectiveConfig(null, { verify: "verify-app" })).toMatchObject({ config: { verify: "verify-app" }, sources: { verify: "settings" } });
});
