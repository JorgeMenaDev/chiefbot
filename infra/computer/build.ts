// Builds the bot computer image. Run from the repo root: `bun run computer:build`.
// 1. Bundles the worker into dist/worker.js. The Copilot SDK stays out of the
//    bundle: it finds its bundled runtime in a platform package next to itself.
// 2. Writes dist/package.json with the worker's exact SDK version, so the image
//    installs that SDK with the Linux runtime for its own CPU.
// 3. docker build, tagged CHIEFBOT_COMPUTER_IMAGE (default chiefbot-computer:dev).
//    With --dist-only (`bun run computer:dist`) it stops before this step, for a
//    docker buildx build of another platform (docs/deploy-gcp.md).
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const dist = join(import.meta.dir, "dist");
const sdk = "@github/copilot-sdk";
const image = process.env.CHIEFBOT_COMPUTER_IMAGE ?? "chiefbot-computer:dev";

const worker = await Bun.file(join(root, "apps/worker/package.json")).json();
const version = worker.dependencies?.[sdk];
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`apps/worker/package.json must pin ${sdk} to an exact version, found ${version}`);
}

mkdirSync(dist, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [join(root, "apps/worker/src/index.ts")],
  target: "bun",
  external: [sdk],
  outdir: dist,
  naming: "worker.js",
});
if (!bundle.success) throw new AggregateError(bundle.logs, "worker bundle failed");
await Bun.write(join(dist, "package.json"), JSON.stringify({ private: true, dependencies: { [sdk]: version } }, null, 2));
if (process.argv.includes("--dist-only")) process.exit(0);

const build = Bun.spawnSync(["docker", "build", "-t", image, import.meta.dir], { stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
console.log(`built ${image} with ${sdk} ${version}`);
