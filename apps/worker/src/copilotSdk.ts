import { CopilotClient } from "@github/copilot-sdk";
import type { Copilot } from "./copilot.ts";

// The real Copilot SDK in copilot-cli mode: the bundled runtime runs in the bot
// computer with its full tool set (shell, files, git), working in `workingDirectory`.
// Session history lives under ~/.copilot, on the bot's own disk.
// GitHub identity comes only from each session's gitHubTokenProvider, never from
// a logged-in user or an env token. The runtime's shell inherits agentEnv() plus
// `gitConfig`, the GIT_CONFIG_* variables that send git to control's proxy.
export function copilotSdk({ workingDirectory, gitConfig }: { workingDirectory: string; gitConfig: Record<string, string> }): Copilot {
  const client = new CopilotClient({
    mode: "copilot-cli",
    workingDirectory,
    useLoggedInUser: false,
    env: { ...agentEnv(process.env), ...gitConfig },
  });
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

// Tokens the agent's shell is not handed: a GitHub token would let gh or curl
// write to repos without control's approval. The bot credential is withheld too,
// though a process in the computer can still read it (docs/isolation.md).
const withheld = ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "CHIEFBOT_BOT_TOKEN"];

// The environment the Copilot runtime (and every command it runs) gets: the worker's, minus those tokens.
export function agentEnv(env: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !withheld.includes(name)));
}

// The real Copilot SDK in empty mode, for a project's coordinator: no shell, no
// files, no ambient config or skills. Each session can use only the custom tools
// it is opened with. Session history lives under `baseDirectory`.
export function coordinatorSdk({ baseDirectory }: { baseDirectory: string }): Copilot {
  const client = new CopilotClient({ mode: "empty", baseDirectory, useLoggedInUser: false });
  return {
    async openSession(options) {
      const config = coordinatorSessionConfig(options);
      await client.start();
      const existing = await client.getSessionMetadata(options.sessionId);
      return existing
        ? client.resumeSession(options.sessionId, config)
        : client.createSession({ ...config, sessionId: options.sessionId });
    },
  };
}

// A coordinator session's config: its tools are the only ones it may use, and
// its instructions follow the SDK's own system message.
export function coordinatorSessionConfig({
  gitHubTokenProvider,
  onPermissionRequest,
  tools,
  instructions,
}: Parameters<Copilot["openSession"]>[0]) {
  return {
    gitHubTokenProvider,
    onPermissionRequest,
    tools,
    streaming: true,
    availableTools: tools.map(({ name }) => `custom:${name}`),
    ...(instructions === undefined ? {} : { systemMessage: { mode: "append" as const, content: instructions } }),
  };
}
