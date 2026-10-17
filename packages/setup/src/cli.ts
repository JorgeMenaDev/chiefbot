import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { chiefbotHome } from "./config.ts";
import { nextSteps, runSetup } from "./setup.ts";

// bun run setup [--org <organization> [--org-billed-copilot]] [--oauth-client-id <client id>]
// --org-billed-copilot: the repo app may also make Copilot requests, so the
// organization can pay for its projects' agents (README, "Org-billed Copilot").
// --oauth-client-id: sign in with an OAuth App you made (README, "Fallback: an
// OAuth App to sign in") instead of a sign-in GitHub App.
// Env: CHIEFBOT_HOME (default ~/.chiefbot); CHIEFBOT_GITHUB_URL and
// CHIEFBOT_GITHUB_API_URL (default github.com) point it at another GitHub.
const { values } = parseArgs({ options: { org: { type: "string" }, "org-billed-copilot": { type: "boolean" }, "oauth-client-id": { type: "string" } } });
const githubUrl = process.env.CHIEFBOT_GITHUB_URL ?? "https://github.com";
const dir = chiefbotHome(process.env, homedir());

try {
  const result = await runSetup({
    githubUrl,
    githubApiUrl: process.env.CHIEFBOT_GITHUB_API_URL ?? "https://api.github.com",
    dir,
    ...(values.org === undefined ? {} : { org: values.org }),
    ...(values["oauth-client-id"] === undefined ? {} : { oauthClientId: values["oauth-client-id"] }),
    orgBilledCopilot: values["org-billed-copilot"] === true,
    open: async (url) => {
      console.log(`Opening ${url} to register your GitHub Apps on ${values.org ?? "your account"}.`);
      console.log("If no browser opens, open that link yourself. Then click Create GitHub App on each page.");
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      try {
        Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
      } catch {
        // No opener on this machine: the link above is enough.
      }
    },
  });
  const signIn = result.signIn.kind === "github-app" ? result.signIn.app.htmlUrl : `the OAuth App ${result.signIn.clientId}`;
  console.log(`\nSaved the repo app ${result.app.htmlUrl} and the sign-in app (${signIn}) in ${dir}.\nLeft to do:`);
  for (const step of nextSteps(result)) console.log(step);
  console.log("\nThen run `bun run computer:build` once and `bun run dev`.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
