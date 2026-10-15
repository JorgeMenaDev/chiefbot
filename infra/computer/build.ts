// Builds the bot computer image. Run from the repo root: `bun run computer:build`.
// 1. Bundles the worker into dist/worker.js, git's credential helper into
//    dist/git-credential.js and its pre-push hook into dist/pre-push.js. The Copilot SDK stays out of the bundle: it finds
//    its bundled runtime in a platform package next to itself.
// 2. Writes dist/package.json with the worker's exact SDK version, so the image
//    installs that SDK with the Linux runtime for its own CPU.
// 3. docker build, tagged CHIEFBOT_COMPUTER_IMAGE (default chiefbot-computer:dev).
//    With --dist-only (`bun run computer:dist`) it stops before this step, for a
//    docker buildx build of another platform (docs/deploy-gcp.md).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import workerPackage from "../../apps/worker/package.json" with { type: "json" };

const root = join(import.meta.dir, "../..");
const dist = join(import.meta.dir, "dist");
const sdk = "@github/copilot-sdk";
const image = process.env.CHIEFBOT_COMPUTER_IMAGE ?? "chiefbot-computer:dev";

// Typed from the JSON itself, so a missing SDK dependency fails to compile.
const version = workerPackage.dependencies[sdk];
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`apps/worker/package.json must pin ${sdk} to an exact version, found ${version}`);
}

mkdirSync(dist, { recursive: true });
for (const [entry, naming] of [
  ["index.ts", "worker.js"],
  ["gitCredential.ts", "git-credential.js"],
  ["prePush.ts", "pre-push.js"],
]) {
  const bundle = await Bun.build({
    entrypoints: [join(root, "apps/worker/src", entry)],
    target: "bun",
    external: [sdk],
    outdir: dist,
    naming,
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, `${naming} bundle failed`);
}
await Bun.write(join(dist, "package.json"), JSON.stringify({ private: true, dependencies: { [sdk]: version } }, null, 2));
if (process.argv.includes("--dist-only")) process.exit(0);

const build = Bun.spawnSync(["docker", "build", "-t", image, import.meta.dir], { stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
console.log(`built ${image} with ${sdk} ${version}`);
