import { approveAll, CopilotClient } from "@github/copilot-sdk";
import type { Copilot } from "./copilot.ts";

// The real Copilot SDK in copilot-cli mode: the bundled runtime runs in the bot
// computer with its full tool set (shell, files, git), working in `workingDirectory`.
// Session history lives under ~/.copilot, on the bot's own disk.
// GitHub identity comes only from each session's gitHubTokenProvider, never from
// a logged-in user or an env token.
export function copilotSdk({ workingDirectory }: { workingDirectory: string }): Copilot {
  const client = new CopilotClient({ mode: "copilot-cli", workingDirectory, useLoggedInUser: false });
  return {
    async openSession({ sessionId, gitHubTokenProvider }) {
      // No model here: the worker sets the bot's model before each turn that needs it.
      // Every tool call is approved; ticket #6 asks the user before a push.
      const config = { gitHubTokenProvider, workingDirectory, streaming: true, onPermissionRequest: approveAll };
      await client.start();
      const existing = await client.getSessionMetadata(sessionId);
      return existing ? client.resumeSession(sessionId, config) : client.createSession({ ...config, sessionId });
    },
  };
}
