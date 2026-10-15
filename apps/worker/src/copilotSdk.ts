import { CopilotClient } from "@github/copilot-sdk";
import type { Copilot } from "./copilot.ts";

// The real Copilot SDK in copilot-cli mode: the bundled runtime runs in the bot
// computer with its full tool set (shell, files, git), working in `workingDirectory`.
// Session history lives under ~/.copilot, on the bot's own disk.
// GitHub identity comes only from each session's gitHubTokenProvider, never from
// a logged-in user or an env token. The runtime's shell inherits agentEnv().
export function copilotSdk({ workingDirectory }: { workingDirectory: string }): Copilot {
  const client = new CopilotClient({ mode: "copilot-cli", workingDirectory, useLoggedInUser: false, env: agentEnv(process.env) });
  return {
    async openSession({ sessionId, gitHubTokenProvider, onPermissionRequest, tools }) {
      // No model here: the worker sets the bot's model before each turn that needs it.
      const config = { gitHubTokenProvider, workingDirectory, streaming: true, onPermissionRequest, tools };
      await client.start();
      const existing = await client.getSessionMetadata(sessionId);
      return existing ? client.resumeSession(sessionId, config) : client.createSession({ ...config, sessionId });
    },
  };
}

// Tokens the agent's shell must not hold: with a GitHub token, gh or curl could
// open a pull request without the approval-gated create_pull_request tool; with
// the bot credential, it could fetch the owner's token from control's broker.
const withheld = ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "CHIEFBOT_BOT_TOKEN"];

// The environment the Copilot runtime (and every command it runs) gets: the worker's, minus those tokens.
export function agentEnv(env: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !withheld.includes(name)));
}
