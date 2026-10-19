import { ConnectionDefinition, ConnectionName } from "@chiefbot/contracts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// The connections the repo ships: connections/ at its root.
export const repoConnections = join(import.meta.dir, "../../../../connections");

// One connection control offers: its folder's name, its definition and its SKILL.md.
export type CatalogConnection = ConnectionDefinition & { name: ConnectionName; skill: string };

// Reads every connection folder in `dir` (connections/<name>/connection.yaml and
// SKILL.md), in name order. Control calls it once at startup: a folder that breaks
// a rule (its name, its definition, a SKILL.md whose frontmatter `name` is not the
// folder's) throws, naming the file and what is wrong, so control does not start.
export function loadConnections(dir: string): CatalogConnection[] {
  const folders = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  return folders
    .map(({ name }) => name)
    .sort()
    .map((folder) => {
      const file = (name: string) => join(dir, folder, name);
      const name = ConnectionName.safeParse(folder);
      if (!name.success) throw new Error(`${join(dir, folder)}: ${z.prettifyError(name.error)}`);
      const definition = ConnectionDefinition.safeParse(readYaml(file("connection.yaml")));
      if (!definition.success) throw new Error(`${file("connection.yaml")}: ${z.prettifyError(definition.error)}`);
      const skill = read(file("SKILL.md"));
      if (frontmatterName(skill) !== folder) throw new Error(`${file("SKILL.md")}: its frontmatter must start with name: ${folder}`);
      return { ...definition.data, name: name.data, skill };
    });
}

function read(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`${path}: missing`);
  }
}

function readYaml(path: string): unknown {
  const text = read(path);
  try {
    return Bun.YAML.parse(text);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// The `name` in a SKILL.md's YAML frontmatter (between the first two `---` lines), if any.
function frontmatterName(markdown: string) {
  const [, frontmatter] = markdown.match(/^---\n([\s\S]*?)\n---\n/) ?? [];
  if (frontmatter === undefined) return null;
  const parsed = z.object({ name: z.string() }).safeParse(Bun.YAML.parse(frontmatter));
  return parsed.success ? parsed.data.name : null;
}
