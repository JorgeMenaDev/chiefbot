import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConnections, repoConnections } from "./catalog.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A connections folder holding `folders`, each a map of file name to content.
function connectionsDir(folders: Record<string, Record<string, string>>) {
  const dir = mkdtempSync(join(tmpdir(), "chiefbot-connections-"));
  dirs.push(dir);
  for (const [name, files] of Object.entries(folders)) {
    mkdirSync(join(dir, name));
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, name, file), content);
  }
  return dir;
}

const skill = (name: string) => `---\nname: ${name}\ndescription: Use the tool.\n---\nRun it.\n`;
const definition = "title: Tool\ndescription: A tool.\ncli: tool\nfields:\n  token: { label: Token, secret: true }\nenv:\n  TOOL_TOKEN: \"{token}\"\n";

test("every connection the repo ships loads, in folder order, with its skill", () => {
  const catalog = loadConnections(repoConnections);

  expect(catalog.map(({ name, cli }) => [name, cli])).toEqual([
    ["gcloud", "gcloud"],
    ["harness", "harness"],
    ["jira", "acli"],
    ["looker", "looker"],
  ]);
  for (const connection of catalog) expect(connection.skill).toStartWith(`---\nname: ${connection.name}\n`);
});

test("a folder that breaks the rules stops control, naming the file and what is wrong", () => {
  const load = (files: Record<string, string>) => () => loadConnections(connectionsDir({ tool: files }));

  expect(load({ "connection.yaml": definition, "SKILL.md": skill("tool") })).not.toThrow();
  expect(load({ "connection.yaml": definition.replace("{token}", "{tokn}"), "SKILL.md": skill("tool") })).toThrow(
    /tool\/connection\.yaml[\s\S]*\{tokn\} names no field[\s\S]*env\.TOOL_TOKEN/,
  );
  expect(load({ "connection.yaml": `${definition}extra: 1\n`, "SKILL.md": skill("tool") })).toThrow(/tool\/connection\.yaml[\s\S]*extra/);
  expect(load({ "connection.yaml": definition, "SKILL.md": skill("other") })).toThrow(/tool\/SKILL\.md[\s\S]*name: tool/);
  expect(load({ "connection.yaml": definition })).toThrow(/tool\/SKILL\.md/);
  expect(() => loadConnections(connectionsDir({ "Not Valid": { "connection.yaml": definition, "SKILL.md": skill("Not Valid") } }))).toThrow(
    /Not Valid[\s\S]*lower-case/,
  );
});
