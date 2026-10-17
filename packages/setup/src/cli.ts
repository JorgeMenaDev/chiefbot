import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { chiefbotHome } from "./config.ts";
import { nextSteps, runSetup } from "./setup.ts";

// bun run setup [--org <organization>]
// Env: CHIEFBOT_HOME (default ~/.chiefbot); CHIEFBOT_GITHUB_URL and
// CHIEFBOT_GITHUB_API_URL (default github.com) point it at another GitHub.
const { values } = parseArgs({ options: { org: { type: "string" } } });
const githubUrl = process.env.CHIEFBOT_GITHUB_URL ?? "https://github.com";
const dir = chiefbotHome(process.env, homedir());

try {
  const result = await runSetup({
    githubUrl,
    githubApiUrl: process.env.CHIEFBOT_GITHUB_API_URL ?? "https://api.github.com",
    dir,
    ...(values.org === undefined ? {} : { org: values.org }),
    open: async (url) => {
      console.log(`Opening ${url} to register your GitHub App on ${values.org ?? "your account"}.`);
      console.log("If no browser opens, open that link yourself. Then click Create GitHub App.");
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      try {
        Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
      } catch {
        // No opener on this machine: the link above is enough.
      }
    },
  });
  console.log(`\nRegistered ${result.app.htmlUrl} and saved it in ${dir}.\nTwo clicks left:`);
  for (const step of nextSteps(result)) console.log(step);
  console.log("\nThen run `bun run computer:build` once and `bun run dev`.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
