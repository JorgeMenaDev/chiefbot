import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// What the catalogs the repo ships (connections/, templates/) share: one folder per
// entry, read once when control starts. Each problem throws, naming the file.

// The folders in `dir`, in name order, each name checked against `Name` (a bad one
// throws, naming the folder), with a function to a file inside it.
export function catalogFolders(dir: string, Name: z.ZodType<string>) {
  const folders = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  return folders
    .map(({ name }) => name)
    .sort()
    .map((folder) => {
      const name = Name.safeParse(folder);
      if (!name.success) throw new Error(`${join(dir, folder)}: ${z.prettifyError(name.error)}`);
      return { name: name.data, file: (file: string) => join(dir, folder, file) };
    });
}

export function readText(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`${path}: missing`);
  }
}

export function readYaml(path: string): unknown {
  const text = readText(path);
  try {
    return Bun.YAML.parse(text);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
