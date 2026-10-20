// Builds the bot computer image. Run from the repo root: `bun run computer:build`
// runs docker build (infra/computer/Dockerfile, the repo as context), tagged
// CHIEFBOT_COMPUTER_IMAGE (default chiefbot-computer:dev). The Dockerfile's first
// stage runs this file with --dist-only, which:
// 1. Bundles the worker into dist/worker.js and git's credential helper (for
//    control's git proxy) into dist/git-credential.js. The Copilot SDK stays out of the bundle: it finds
//    its bundled runtime in a platform package next to itself.
// 2. Writes dist/package.json with the worker's exact SDK version, so the image
//    installs that SDK with the Linux runtime for its own CPU.
// 3. Draws the desktop's wallpaper into dist/wallpaper.png (wallpaper.ts).
// 4. Writes the computer's own ports into dist/ports.env (VNC_PORT=5900), from the one
//    list in packages/contracts (computer.ts), for start.sh.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import workerPackage from "../../apps/worker/package.json" with { type: "json" };
import { computerPorts } from "../../packages/contracts/src/computer.ts";
import { wallpaper } from "./wallpaper.ts";

const root = join(import.meta.dir, "../..");
const dist = join(import.meta.dir, "dist");
const sdk = "@github/copilot-sdk";
const image = process.env.CHIEFBOT_COMPUTER_IMAGE ?? "chiefbot-computer:dev";

// Typed from the JSON itself, so a missing SDK dependency fails to compile.
const version = workerPackage.dependencies[sdk];
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`apps/worker/package.json must pin ${sdk} to an exact version, found ${version}`);
}

if (!process.argv.includes("--dist-only")) {
  const build = Bun.spawnSync(["docker", "build", "-f", join(import.meta.dir, "Dockerfile"), "-t", image, root], { stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
  console.log(`built ${image} with ${sdk} ${version}`);
  process.exit(0);
}

mkdirSync(dist, { recursive: true });
for (const [entry, naming] of [
  ["index.ts", "worker.js"],
  ["gitCredential.ts", "git-credential.js"],
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
// The screen's size: Xvfb in start.sh.
await Bun.write(join(dist, "wallpaper.png"), wallpaper(1280, 800));
await Bun.write(join(dist, "ports.env"), Object.entries(computerPorts).map(([name, { port }]) => `${name.toUpperCase()}_PORT=${port}\n`).join(""));
