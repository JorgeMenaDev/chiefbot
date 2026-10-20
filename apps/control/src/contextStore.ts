import { ContextPath, type ContextFile, type ContextImagePath, type ProjectId } from "@chiefbot/contracts";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

// Where projects' shared context files live: Markdown every agent of the project
// reads and adds to, and the PNG images it shows (a verifier's screenshots).
// Control owns them, never a computer, so they outlive every worker's. localContextStore
// keeps them on control's disk; a bucket (GCS) can implement the same interface.
// Paths are ContextPaths, so they cannot leave the project's folder.
export type ContextStore = {
  // Every Markdown file of the project, by path.
  list(projectId: ProjectId): Promise<ContextFile[]>;
  // Null when the project has no such file.
  read(projectId: ProjectId, path: ContextPath): Promise<string | null>;
  // Creates or replaces the file.
  write(projectId: ProjectId, path: ContextPath, content: string): Promise<ContextFile>;
  // An image's bytes; null when the project has no such image.
  readImage(projectId: ProjectId, path: ContextImagePath): Promise<Uint8Array | null>;
  // Creates or replaces the image.
  writeImage(projectId: ProjectId, path: ContextImagePath, bytes: Uint8Array): Promise<void>;
  // Deletes all of the project's files.
  remove(projectId: ProjectId): Promise<void>;
};

// One folder per project under `root`.
export function localContextStore(root: string): ContextStore {
  const folder = (projectId: ProjectId) => join(root, projectId);
  const describe = async (projectId: ProjectId, path: ContextPath): Promise<ContextFile> => {
    const { size, mtimeMs } = await stat(join(folder(projectId), path));
    return { path, size, updatedAt: mtimeMs };
  };

  return {
    async list(projectId) {
      const entries = await readdir(folder(projectId), { recursive: true, withFileTypes: true }).catch(() => []);
      const paths = entries
        .filter((entry) => entry.isFile())
        .map((entry) => ContextPath.safeParse(relative(folder(projectId), join(entry.parentPath, entry.name))))
        .flatMap((path) => (path.success ? [path.data] : []))
        .sort();
      return Promise.all(paths.map((path) => describe(projectId, path)));
    },
    async read(projectId, path) {
      return readFile(join(folder(projectId), path), "utf8").catch(() => null);
    },
    async write(projectId, path, content) {
      const file = join(folder(projectId), path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
      return describe(projectId, path);
    },
    async readImage(projectId, path) {
      return readFile(join(folder(projectId), path)).catch(() => null);
    },
    async writeImage(projectId, path, bytes) {
      const file = join(folder(projectId), path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
    },
    async remove(projectId) {
      await rm(folder(projectId), { recursive: true, force: true });
    },
  };
}
